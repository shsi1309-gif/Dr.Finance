const express = require('express');
const multer  = require('multer');
const path    = require('path');
const cors    = require('cors');
const fs      = require('fs');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
require('dotenv').config();

const supabase        = require('./db');
const processDocument = require('./ocrProcessor');
const sendEmailReport = require('./emailService');

const app = express();

// ── MIDDLEWARE ──
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS', 'DELETE'],
    credentials: false
}));
app.use(express.json());
app.use('/uploads', express.static('uploads'));

// ── JWT ──
const JWT_SECRET = process.env.JWT_SECRET || 'drfinance_secret_change_in_production';

const authenticate = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Access token required.' });
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.userId = decoded.userId;
        next();
    } catch {
        return res.status(401).json({ message: 'Invalid or expired token.' });
    }
};

// ── MULTER ──
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = './uploads/';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const safeExt = path.extname(file.originalname).toLowerCase();
        cb(null, `${file.fieldname}-${Date.now()}${safeExt}`);
    }
});

const fileFilter = (req, file, cb) => {
    const allowedMimes = ['image/jpeg', 'image/jpg', 'image/png', 'application/pdf'];
    const allowedExts  = /\.(jpeg|jpg|png|pdf)$/i;
    if (allowedMimes.includes(file.mimetype) && allowedExts.test(file.originalname)) {
        cb(null, true);
    } else {
        cb(new Error('Only .png, .jpg, .jpeg, and .pdf files are allowed!'));
    }
};

const upload = multer({
    storage,
    fileFilter,
    limits: { fileSize: 10 * 1024 * 1024 },
}).single('payout_screenshot');

// =============================================================================
// AI TRANSACTION CLEANUP
// =============================================================================

const AI_TRANSACTION_CATEGORIES = [
    'Food & Dining',
    'Grocery',
    'Shopping',
    'Bills & Utilities',
    'Travel',
    'Entertainment',
    'Health',
    'Education',
    'Transfer',
    'Others',
];

const OPENROUTER_MODELS = [
    'openrouter/free',
    'meta-llama/llama-3.3-70b-instruct:free',
    'google/gemma-3-27b-it:free',
    'qwen/qwen3-8b:free',
];

const parseJsonFromAIText = (rawText) => {
    const cleaned = String(rawText || '').replace(/```json|```/g, '').trim();
    const match = cleaned.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
    if (!match) return null;

    try {
        return JSON.parse(match[0]);
    } catch {
        return null;
    }
};

const normalizeTransactionText = (value, fallback = '') => {
    const text = String(value || fallback || '').replace(/\s+/g, ' ').trim();
    return text.slice(0, 80);
};

const normalizeAITransaction = (aiTx, originalTx, index) => {
    const originalAmount = Number(originalTx.amount);
    const aiAmount = Number(aiTx?.amount);
    const amount = Number.isFinite(aiAmount) && aiAmount > 0 && Math.abs(aiAmount - originalAmount) / originalAmount <= 0.05
        ? aiAmount
        : originalAmount;

    const category = AI_TRANSACTION_CATEGORIES.includes(aiTx?.category)
        ? aiTx.category
        : (originalTx.category || 'Others');

    const parsedDate = aiTx?.date ? new Date(aiTx.date) : null;
    const date = parsedDate && !Number.isNaN(parsedDate.getTime())
        ? parsedDate.toISOString().split('T')[0]
        : originalTx.date;

    const recipient = normalizeTransactionText(aiTx?.recipient || aiTx?.merchant, originalTx.recipient || 'General Expense');
    const description = normalizeTransactionText(aiTx?.description, originalTx.description || recipient);

    return {
        ...originalTx,
        amount,
        recipient,
        description,
        category,
        date,
        dateTime: originalTx.dateTime || date,
        ai: {
            enhanced: true,
            confidence: Math.max(0, Math.min(1, Number(aiTx?.confidence) || 0)),
            note: normalizeTransactionText(aiTx?.note || aiTx?.notes, ''),
            originalIndex: Number.isInteger(aiTx?.index) ? aiTx.index : index,
        },
    };
};

async function enhanceTransactionsWithAI(transactions) {
    const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
    if (!OPENROUTER_KEY || transactions.length === 0) {
        return { transactions, enabled: false, message: OPENROUTER_KEY ? 'No transactions to enhance.' : 'AI key not configured.' };
    }

    const compactTransactions = transactions.slice(0, 60).map((tx, index) => ({
        index,
        amount: Number(tx.amount),
        recipient: tx.recipient || '',
        description: tx.description || '',
        category: tx.category || 'Others',
        date: tx.date || '',
        dateTime: tx.dateTime || '',
    }));

    const prompt = `You clean OCR-extracted Indian personal finance transactions.

Rules:
- Keep exactly one output object per input object and preserve the same index.
- Do not invent transactions.
- Clean merchant/recipient names, fix obvious OCR casing/spaces, and choose the best category.
- Categories must be one of: ${AI_TRANSACTION_CATEGORIES.join(', ')}.
- Amount should usually stay the same. Only change amount for obvious OCR decimal/comma cleanup.
- Return ONLY a JSON array, no markdown.

Input transactions:
${JSON.stringify(compactTransactions)}

Output schema:
[
  {
    "index": 0,
    "amount": 123.45,
    "recipient": "Clean merchant or person name",
    "description": "Short clean transaction description",
    "category": "Food & Dining",
    "date": "YYYY-MM-DD",
    "confidence": 0.0,
    "note": "Very short reason for category"
  }
]`;

    let lastError = null;

    for (const model of OPENROUTER_MODELS) {
        try {
            const aiRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${OPENROUTER_KEY}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': process.env.FRONTEND_URL || 'http://localhost:5173',
                    'X-Title': 'Dr. Finance AI'
                },
                body: JSON.stringify({
                    model,
                    messages: [{ role: 'user', content: prompt }],
                    max_tokens: 2200,
                    temperature: 0.1
                })
            });

            if (!aiRes.ok) {
                lastError = await aiRes.text();
                console.warn(`AI cleanup model ${model} failed:`, lastError);
                continue;
            }

            const aiData = await aiRes.json();
            const parsed = parseJsonFromAIText(aiData.choices?.[0]?.message?.content);
            if (!Array.isArray(parsed)) {
                lastError = 'AI cleanup returned invalid JSON.';
                console.warn(lastError);
                continue;
            }

            const aiByIndex = new Map(parsed.map((tx, index) => [
                Number.isInteger(tx?.index) ? tx.index : index,
                tx,
            ]));

            const enhanced = transactions.map((tx, index) => {
                const aiTx = aiByIndex.get(index);
                return aiTx ? normalizeAITransaction(aiTx, tx, index) : tx;
            });

            console.log(`AI cleanup response from: ${model}`);
            return { transactions: enhanced, enabled: true, model };
        } catch (err) {
            lastError = err.message;
            console.warn(`AI cleanup error with model: ${model}`, err.message);
        }
    }

    console.warn('AI cleanup skipped. Falling back to OCR parser output.', lastError);
    return { transactions, enabled: false, message: 'AI cleanup unavailable. Used OCR parser output.' };
}

const formatINR = (value) => `₹${Math.round(Number(value) || 0).toLocaleString('en-IN')}`;

const buildTransactionInsights = (transactions) => {
    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();
    const currentMonthTransactions = transactions.filter(tx => {
        const d = new Date(tx.date);
        return d.getMonth() === currentMonth && d.getFullYear() === currentYear;
    });

    const source = currentMonthTransactions.length ? currentMonthTransactions : transactions;
    const totalSpent = source.reduce((sum, tx) => sum + Number(tx.amount || 0), 0);
    const categoryTotals = {};
    const merchantTotals = {};

    source.forEach(tx => {
        const category = tx.category || 'Others';
        const merchant = tx.recipient || 'Unknown';
        categoryTotals[category] = (categoryTotals[category] || 0) + Number(tx.amount || 0);
        merchantTotals[merchant] = (merchantTotals[merchant] || 0) + Number(tx.amount || 0);
    });

    const topCategories = Object.entries(categoryTotals)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, amount]) => ({ name, amount }));

    const topMerchants = Object.entries(merchantTotals)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, amount]) => ({ name, amount }));

    return {
        period: currentMonthTransactions.length ? 'current month' : 'all available transactions',
        transactionCount: source.length,
        totalSpent,
        topCategories,
        topMerchants,
        recentTransactions: transactions.slice(0, 25).map(tx => ({
            amount: Number(tx.amount || 0),
            recipient: tx.recipient || 'Unknown',
            category: tx.category || 'Others',
            date: tx.date,
        })),
    };
};

const getLocalFinanceAnswer = (question, insights) => {
    const q = String(question || '').toLowerCase();
    const topCategory = insights.topCategories[0];
    const topMerchant = insights.topMerchants[0];
    const targetMatch = q.match(/(?:save|saving|savings)\D*(\d[\d,]*)/i);
    const target = targetMatch ? Number(targetMatch[1].replace(/,/g, '')) : null;

    if (/where.*spend|spent.*most|highest|top/.test(q) && topCategory) {
        return `You spent the most on ${topCategory.name}: ${formatINR(topCategory.amount)} in ${insights.period}. Your highest merchant/person is ${topMerchant?.name || 'Unknown'} at ${formatINR(topMerchant?.amount || 0)}.`;
    }

    if (target) {
        const flexibleCategories = insights.topCategories.filter(c =>
            ['Food & Dining', 'Shopping', 'Entertainment', 'Travel', 'Others'].includes(c.name)
        );
        const possibleSavings = flexibleCategories.reduce((sum, c) => sum + c.amount * 0.2, 0);
        const canSave = possibleSavings >= target;
        const firstCut = flexibleCategories[0];
        return canSave
            ? `Yes, ${formatINR(target)} looks possible if you cut around 20% from flexible categories. Start with ${firstCut?.name || 'your top non-essential category'}, where current spend is ${formatINR(firstCut?.amount || 0)}.`
            : `Saving ${formatINR(target)} may be difficult from visible spending alone. A realistic first target is around ${formatINR(possibleSavings)} by trimming flexible categories like ${flexibleCategories.map(c => c.name).slice(0, 3).join(', ') || 'shopping and dining'}.`;
    }

    if (/reduce|cut|expense|expenses|first|priority/.test(q) && topCategory) {
        const cutCandidates = insights.topCategories.filter(c =>
            ['Food & Dining', 'Shopping', 'Entertainment', 'Travel', 'Others'].includes(c.name)
        );
        const candidate = cutCandidates[0] || topCategory;
        return `Reduce ${candidate.name} first. It is currently ${formatINR(candidate.amount)}, and even a 15-20% cut could free up ${formatINR(candidate.amount * 0.18)}.`;
    }

    return `For ${insights.period}, you spent ${formatINR(insights.totalSpent)} across ${insights.transactionCount} transactions. Your top category is ${topCategory?.name || 'N/A'} at ${formatINR(topCategory?.amount || 0)}. Ask about savings, top spending, or which expense to reduce first.`;
};

// =============================================================================
// AUTH ROUTES
// =============================================================================

// REGISTER
app.post('/api/auth/register', async (req, res) => {
    try {
        const { name, email, password } = req.body;

        if (!name || !email || !password)
            return res.status(400).json({ message: 'Name, email and password are required.' });

        if (password.length < 6)
            return res.status(400).json({ message: 'Password must be at least 6 characters.' });

        const cleanEmail = email.toLowerCase().trim();

        // Check if user already exists
        const { data: existing } = await supabase
            .from('users')
            .select('id')
            .eq('email', cleanEmail)
            .maybeSingle();

        if (existing)
            return res.status(409).json({ message: 'An account with this email already exists.' });

        const hashedPassword = await bcrypt.hash(password, 12);

        const { data: user, error } = await supabase
            .from('users')
            .insert([{ name: name.trim(), email: cleanEmail, password: hashedPassword }])
            .select('id, name, email')
            .single();

        if (error) throw error;

        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });

        res.status(201).json({
            token,
            user: { _id: user.id, name: user.name, email: user.email }
        });

    } catch (err) {
        console.error('Register error:', err.message);
        res.status(500).json({ message: 'Registration failed.' });
    }
});

// LOGIN
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password)
            return res.status(400).json({ message: 'Email and password are required.' });

        const cleanEmail = email.toLowerCase().trim();

        const { data: user, error } = await supabase
            .from('users')
            .select('id, name, email, password')
            .eq('email', cleanEmail)
            .maybeSingle();

        if (error || !user)
            return res.status(401).json({ message: 'Invalid email or password.' });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch)
            return res.status(401).json({ message: 'Invalid email or password.' });

        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });

        res.status(200).json({
            token,
            user: { _id: user.id, name: user.name, email: user.email }
        });

    } catch (err) {
        console.error('Login error:', err.message);
        res.status(500).json({ message: 'Login failed.' });
    }
});

// FORGOT PASSWORD
app.post('/api/auth/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ message: 'Email is required.' });

        const cleanEmail = email.toLowerCase().trim();
        const { data: user } = await supabase
            .from('users')
            .select('id, name, email')
            .eq('email', cleanEmail)
            .maybeSingle();

        if (!user) return res.status(200).json({ message: 'If this email exists, a reset link has been sent.' });

        const crypto  = require('crypto');
        const token   = crypto.randomBytes(32).toString('hex');
        const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

        // Invalidate old tokens
        await supabase.from('password_reset_tokens').update({ used: true }).eq('user_id', user.id).eq('used', false);

        // Store new token
        const { error: tokenError } = await supabase
            .from('password_reset_tokens')
            .insert([{ user_id: user.id, token, expires_at: expires.toISOString() }]);
        if (tokenError) throw tokenError;

        const resetLink   = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/reset-password?token=${token}`;
        const nodemailer  = require('nodemailer');
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
        });

        await transporter.sendMail({
            from: `"Dr. Finance AI" <${process.env.EMAIL_USER}>`,
            to: user.email,
            subject: 'Reset your Dr. Finance AI password',
            html: `
                <div style="background:#080808;padding:40px;font-family:'Segoe UI',Arial,sans-serif;max-width:520px;margin:0 auto;">
                    <div style="font-size:22px;font-weight:900;letter-spacing:2px;color:#f0ece4;margin-bottom:4px;">DR. FINANCE <span style="color:#d4a843;">AI</span></div>
                    <div style="font-size:11px;color:#444;letter-spacing:2px;font-family:monospace;margin-bottom:28px;">PASSWORD RESET</div>
                    <div style="background:#0f0f0f;border:1px solid #1a1a1a;border-radius:12px;padding:24px;margin-bottom:20px;">
                        <p style="color:#888;font-size:14px;margin-bottom:20px;">Hi ${user.name},<br><br>Click the button below to reset your password. This link expires in <strong style="color:#d4a843;">1 hour</strong>.</p>
                        <a href="${resetLink}" style="display:inline-block;padding:14px 28px;background:linear-gradient(135deg,#d4a843,#a07420);color:#000;font-weight:700;font-size:14px;border-radius:10px;text-decoration:none;">Reset My Password</a>
                    </div>
                    <p style="color:#333;font-size:12px;font-family:monospace;">If you did not request this, ignore this email.</p>
                    <div style="margin-top:20px;border-top:1px solid #1a1a1a;padding-top:16px;text-align:center;font-size:11px;color:#333;font-family:monospace;">Dr. Finance AI · Do not reply</div>
                </div>
            `
        });

        console.log(`📧 Reset email sent to ${user.email}`);
        res.status(200).json({ message: 'If this email exists, a reset link has been sent.' });

    } catch (err) {
        console.error('Forgot password error:', err.message);
        res.status(500).json({ message: 'Failed to send reset email.' });
    }
});

// RESET PASSWORD
app.post('/api/auth/reset-password', async (req, res) => {
    try {
        const { token, password } = req.body;
        if (!token || !password) return res.status(400).json({ message: 'Token and password are required.' });
        if (password.length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters.' });

        const { data: resetToken } = await supabase
            .from('password_reset_tokens')
            .select('*')
            .eq('token', token)
            .eq('used', false)
            .maybeSingle();

        if (!resetToken) return res.status(400).json({ message: 'Invalid or expired reset link.' });
        if (new Date(resetToken.expires_at) < new Date()) return res.status(400).json({ message: 'Reset link has expired. Please request a new one.' });

        const hashedPassword = await bcrypt.hash(password, 12);

        const { error: updateError } = await supabase
            .from('users')
            .update({ password: hashedPassword })
            .eq('id', resetToken.user_id);
        if (updateError) throw updateError;

        await supabase.from('password_reset_tokens').update({ used: true }).eq('id', resetToken.id);

        res.status(200).json({ message: 'Password reset successfully. You can now log in.' });

    } catch (err) {
        console.error('Reset password error:', err.message);
        res.status(500).json({ message: 'Password reset failed.' });
    }
});

// =============================================================================
// TRANSACTION ROUTES
// =============================================================================

// GET ALL (scoped to logged-in user)
app.get('/api/transactions', authenticate, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('transactions')
            .select('*')
            .eq('user_id', req.userId)
            .order('date', { ascending: false });

        if (error) throw error;

        // Normalize field names to match what the frontend expects
        const normalized = (data || []).map(tx => ({
            _id:         tx.id,
            amount:      Number(tx.amount),
            recipient:   tx.recipient,
            description: tx.description,
            category:    tx.category,
            userEmail:   tx.user_email,
            dateTime:    tx.date_time,
            date:        tx.date,
        }));

        res.status(200).json(normalized);

    } catch (err) {
        console.error('Fetch error:', err.message);
        res.status(500).json({ message: 'Could not fetch data' });
    }
});

// UPLOAD & PROCESS
app.post('/api/upload', authenticate, (req, res) => {
    upload(req, res, async (err) => {
        if (err instanceof multer.MulterError)
            return res.status(400).json({ message: `Upload error: ${err.message}` });
        if (err)
            return res.status(400).json({ message: err.message });
        if (!req.file)
            return res.status(400).json({ message: 'No file uploaded!' });

        const filePath = req.file.path;
        const cleanup  = () => { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); };

        try {
            console.log(`📂 Processing: ${req.file.filename} (${req.file.mimetype})`);

            const rawResult       = await processDocument(filePath);
            const transactionsArr = Array.isArray(rawResult) ? rawResult : [rawResult];

            const validTransactions = transactionsArr.filter(
                tx => tx && typeof tx.amount === 'number' && tx.amount > 0
            );

            if (validTransactions.length === 0) {
                cleanup();
                return res.status(400).json({ message: 'No valid transaction data found in the document.' });
            }

            const aiCleanup = await enhanceTransactionsWithAI(validTransactions);
            const userEmail = (req.body.email || '').trim().toLowerCase();

            const docsToInsert = aiCleanup.transactions.map(tx => ({
                user_id:    req.userId,
                date:       tx.date ? new Date(tx.date).toISOString() : new Date().toISOString(),
                category:   (tx.category || 'Others').trim(),
                recipient:  tx.recipient ? tx.recipient.trim() : null,
                amount:     tx.amount,
                date_time:  tx.dateTime || null,
                user_email: userEmail || null,
            }));

            const { data: savedData, error: insertError } = await supabase
                .from('transactions')
                .insert(docsToInsert)
                .select();

            if (insertError) throw insertError;

            cleanup();

            // Send PDF report by email (non-blocking)
            if (userEmail && userEmail.includes('@')) {
                const { data: userRecord } = await supabase
                    .from('users')
                    .select('name')
                    .eq('id', req.userId)
                    .maybeSingle();

                sendEmailReport(userEmail, docsToInsert, userRecord?.name || '').catch(() => {});
            }

            res.status(200).json({
                message: `Successfully processed ${savedData.length} record(s).`,
                ai: {
                    cleanupApplied: aiCleanup.enabled,
                    model: aiCleanup.model || null,
                    message: aiCleanup.message || null,
                },
                data: savedData
            });

        } catch (error) {
            cleanup();
            console.error('Processing Error:', error.message);
            res.status(500).json({ message: 'Processing failed', error: error.message });
        }
    });
});

// DELETE (owner only)
app.delete('/api/transactions/:id', authenticate, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('transactions')
            .delete()
            .eq('id', req.params.id)
            .eq('user_id', req.userId)
            .select()
            .maybeSingle();

        if (error) throw error;
        if (!data)
            return res.status(404).json({ message: 'Transaction not found or not authorized.' });

        res.status(200).json({ message: 'Deleted successfully' });

    } catch (err) {
        console.error('Delete error:', err.message);
        res.status(500).json({ message: 'Delete failed' });
    }
});

// =============================================================================
// ASK MY FINANCE CHAT
// =============================================================================

app.post('/api/ai/ask', authenticate, async (req, res) => {
    try {
        const question = String(req.body.question || '').trim();
        if (!question)
            return res.status(400).json({ message: 'Please ask a finance question.' });
        if (question.length > 300)
            return res.status(400).json({ message: 'Please keep your question under 300 characters.' });

        const { data: transactions, error } = await supabase
            .from('transactions')
            .select('amount, recipient, category, date')
            .eq('user_id', req.userId)
            .order('date', { ascending: false })
            .limit(200);

        if (error) throw error;
        if (!transactions || transactions.length === 0)
            return res.status(400).json({ message: 'Upload transactions first, then ask me about your spending.' });

        const insights = buildTransactionInsights(transactions);
        const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;

        if (!OPENROUTER_KEY) {
            return res.status(200).json({
                answer: getLocalFinanceAnswer(question, insights),
                source: 'local',
                insights,
            });
        }

        const prompt = `You are Ask My Finance inside Dr. Finance AI.

Answer the user's finance question using only their transaction summary. Be specific, concise, and practical.
Rules:
- Keep the answer under 120 words.
- Use Indian rupee amounts.
- Do not give regulated investment advice here.
- If data is insufficient, say exactly what is missing.
- Return only JSON: {"answer":"...","followUps":["short question 1","short question 2"]}

Question: ${question}

Transaction summary:
${JSON.stringify(insights)}`;

        let lastError = null;
        for (const model of OPENROUTER_MODELS) {
            try {
                const aiRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${OPENROUTER_KEY}`,
                        'Content-Type': 'application/json',
                        'HTTP-Referer': process.env.FRONTEND_URL || 'http://localhost:5173',
                        'X-Title': 'Dr. Finance AI'
                    },
                    body: JSON.stringify({
                        model,
                        messages: [{ role: 'user', content: prompt }],
                        max_tokens: 500,
                        temperature: 0.25
                    })
                });

                if (!aiRes.ok) {
                    lastError = await aiRes.text();
                    console.warn(`Ask Finance model ${model} failed:`, lastError);
                    continue;
                }

                const aiData = await aiRes.json();
                const parsed = parseJsonFromAIText(aiData.choices?.[0]?.message?.content);
                if (!parsed?.answer) {
                    lastError = 'Ask Finance returned invalid JSON.';
                    continue;
                }

                return res.status(200).json({
                    answer: String(parsed.answer).trim(),
                    followUps: Array.isArray(parsed.followUps) ? parsed.followUps.slice(0, 2) : [],
                    source: 'ai',
                    model,
                });
            } catch (err) {
                lastError = err.message;
                console.warn(`Ask Finance error with model ${model}:`, err.message);
            }
        }

        console.warn('Ask Finance AI unavailable. Falling back locally.', lastError);
        res.status(200).json({
            answer: getLocalFinanceAnswer(question, insights),
            source: 'local',
            message: 'AI unavailable. Used local spending summary.',
            insights,
        });

    } catch (err) {
        console.error('Ask Finance error:', err.message);
        res.status(500).json({ message: 'Ask My Finance failed. Try again.' });
    }
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
