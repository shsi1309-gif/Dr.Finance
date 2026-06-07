const Tesseract = require('tesseract.js');
const { Jimp } = require('jimp');
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const pdf = typeof pdfParse === 'function' ? pdfParse : pdfParse.default;
require('dotenv').config();

// ─── Month map for Paytm date parsing ───
const MONTH_MAP = {
    'jan': 0, 'feb': 1, 'mar': 2, 'apr': 3,
    'may': 4, 'jun': 5, 'jul': 6, 'aug': 7,
    'sep': 8, 'oct': 9, 'nov': 10, 'dec': 11
};

// ─── Tag/Category map from Paytm tags ───
const TAG_CATEGORY_MAP = {
    'money transfer':     'Transfer',
    'bill payments':      'Bills & Utilities',
    'bill payment':       'Bills & Utilities',
    'recharge':           'Bills & Utilities',
    'mobile recharge':    'Bills & Utilities',
    'dth recharge':       'Bills & Utilities',
    'food':               'Food & Dining',
    'food & drinks':      'Food & Dining',
    'groceries':          'Grocery',
    'grocery':            'Grocery',
    'shopping':           'Shopping',
    'travel':             'Travel',
    'fuel':               'Travel',
    'entertainment':      'Entertainment',
    'movies':             'Entertainment',
    'education':          'Education',
    'health':             'Health',
    'healthcare':         'Health',
    'insurance':          'Bills & Utilities',
    'emi':                'Bills & Utilities',
    'loan':               'Bills & Utilities',
};

// ─── Fallback: guess category from recipient name ───
const guessCategoryFromRecipient = (recipient, description) => {
    const text = `${recipient} ${description}`.toLowerCase();

    if (/electricity|bescom|msedcl|tpddl|water|gas|internet|broadband|airtel|jio|vodafone|vi|bsnl|recharge|postpaid|prepaid|bill|emi|insurance/.test(text)) return 'Bills & Utilities';
    if (/swiggy|zomato|mcdonald|burger|kfc|pizza|restaurant|cafe|food|kitchen|dhaba/.test(text)) return 'Food & Dining';
    if (/grocery|bigbasket|blinkit|zepto|dmart|supermarket|vegetables|fruits/.test(text)) return 'Grocery';
    if (/amazon|flipkart|myntra|ajio|shop|store|mall/.test(text)) return 'Shopping';
    if (/ola|uber|rapido|irctc|railway|flight|bus|taxi|cab|travel|metro|train/.test(text)) return 'Travel';
    if (/netflix|prime|hotstar|spotify|cinema|pvr|inox|bookmyshow|game/.test(text)) return 'Entertainment';
    if (/hospital|clinic|pharmacy|medicine|doctor|health|lab|diagnostic/.test(text)) return 'Health';
    if (/school|college|course|tuition|udemy|byjus|education/.test(text)) return 'Education';
    if (/money sent|transfer|sent to|paid to/.test(text)) return 'Transfer';

    return 'Others';
};

// ─── Parse Paytm Passbook PDF text ───
const parsePaytmText = (text) => {
    const transactions = [];
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

    let i = 0;
    while (i < lines.length) {
        const line = lines[i];

        // ── Detect date line: "06 Mar" or "06 Mar 2024" ──
        const dateMatch = line.match(/^(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:\s+(\d{4}))?$/i);

        if (dateMatch) {
            const day   = parseInt(dateMatch[1]);
            const month = MONTH_MAP[dateMatch[2].toLowerCase()];
            const year  = dateMatch[3] ? parseInt(dateMatch[3]) : new Date().getFullYear();
            const date  = new Date(year, month, day);

            // ── Look for time on next line: "8:36 PM" ──
            let timeStr = '';
            if (i + 1 < lines.length && /^\d{1,2}:\d{2}\s*(AM|PM)$/i.test(lines[i + 1])) {
                timeStr = lines[i + 1];
                i++;
            }

            const dateTime = timeStr
                ? `${date.toISOString().split('T')[0]} ${timeStr}`
                : date.toISOString().split('T')[0];

            // ── Scan forward for transaction details ──
            let description = '';
            let recipient   = '';
            let amount      = 0;
            let category    = '';

            // Collect next few lines for this transaction block
            const blockLines = [];
            let j = i + 1;
            while (j < lines.length && j < i + 12) {
                const next = lines[j];
                // Stop if we hit the next date block
                if (/^\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(next)) break;
                blockLines.push(next);
                j++;
            }

            const blockText = blockLines.join(' ');

            // ── Extract amount: "- Rs.7,000" or "Rs.500" or "- Rs.93" ──
            const amountMatch = blockText.match(/-?\s*Rs\.?\s*([\d,]+(?:\.\d{1,2})?)/i);
            if (amountMatch) {
                amount = parseFloat(amountMatch[1].replace(/,/g, ''));
            }

            // ── Extract recipient / description ──
            // Pattern: "Money sent to NAME"
            const sentToMatch = blockText.match(/Money\s+sent\s+to\s+([A-Za-z0-9\s]{2,40}?)(?:\s+(?:UPI|Ref|#|Tag|Rs|\-))/i)
                             || blockText.match(/Money\s+sent\s+to\s+([A-Za-z\s]{2,40})/i);
            // Pattern: "Bill Payment for NAME"
            const billMatch   = blockText.match(/Bill\s+Payment\s+for\s+([A-Za-z0-9\s\(\)]{3,50}?)(?:\s+\d{6,}|\s+#|\s+Rs|$)/i);
            // Pattern: "Paid to NAME"
            const paidMatch   = blockText.match(/Paid\s+to\s+([A-Za-z0-9\s]{2,40}?)(?:\s+(?:UPI|Ref|#|Rs|\-))/i)
                             || blockText.match(/Paid\s+to\s+([A-Za-z\s]{2,40})/i);
            // Pattern: "Received from NAME"  (skip - it's income not expense)
            const receivedMatch = blockText.match(/Received\s+from/i);

            if (receivedMatch) {
                // Skip income transactions
                i = j;
                continue;
            }

            if (sentToMatch) {
                recipient   = sentToMatch[1].trim();
                description = `Money sent to ${recipient}`;
            } else if (billMatch) {
                recipient   = billMatch[1].trim();
                description = `Bill Payment for ${recipient}`;
            } else if (paidMatch) {
                recipient   = paidMatch[1].trim();
                description = `Paid to ${recipient}`;
            } else {
                // Fallback: grab the first meaningful line in the block
                const firstMeaningful = blockLines.find(l =>
                    l.length > 3 &&
                    !/^(Tag|#|Rs|UPI|Ref|Your Account|Notes)/i.test(l) &&
                    !/^\d/.test(l)
                );
                recipient   = firstMeaningful ? firstMeaningful.slice(0, 40).trim() : 'General Expense';
                description = recipient;
            }

            // ── Extract category from Tag ──
            const tagMatch = blockText.match(/#\s*([A-Za-z\s&]+?)(?:\s{2,}|$)/);
            if (tagMatch) {
                const tagKey = tagMatch[1].trim().toLowerCase();
                category = TAG_CATEGORY_MAP[tagKey] || guessCategoryFromRecipient(recipient, description);
            } else {
                category = guessCategoryFromRecipient(recipient, description);
            }

            if (amount > 0 && recipient) {
                transactions.push({
                    amount,
                    recipient,
                    description,
                    category,
                    date: date.toISOString().split('T')[0],
                    dateTime,
                });
            }

            i = j;
            continue;
        }

        i++;
    }

    return transactions;
};

// ─── Fallback generic parser (for non-Paytm PDFs) ───
const parseReceiptText = (text) => {
    const transactions = [];
    const lines = text.split('\n');

    lines.forEach(line => {
        const amountMatch = line.match(/(?:Rs\.?|INR|₹)\s?([\d,]+(?:\.\d{2})?)/i);
        if (amountMatch) {
            const amount = parseFloat(amountMatch[1].replace(/,/g, ''));
            const recipientMatch = line.match(/(?:Paid to|Money sent to|sent to|Redemption|To)\s+([A-Za-z0-9\s]{3,25})/i);
            const recipient = recipientMatch ? recipientMatch[1].trim() : 'General Expense';
            if (amount > 0) {
                transactions.push({
                    amount,
                    recipient,
                    description: recipient,
                    category: guessCategoryFromRecipient(recipient, line),
                    date: new Date().toISOString().split('T')[0],
                    dateTime: new Date().toISOString().split('T')[0],
                });
            }
        }
    });

    return transactions;
};

// ─── Process PDFs ───
const processPDF = async (filePath) => {
    try {
        const dataBuffer = fs.readFileSync(filePath);
        const pdfData    = await pdf(dataBuffer);
        const text       = pdfData.text;

        if (!text || text.trim().length < 5) return [];

        console.log("📄 Extracted PDF text. Detecting format...");

        // Detect Paytm Passbook format
        const isPaytm = /Passbook|Paytm|Money sent to|Bill Payment for/i.test(text);

        if (isPaytm) {
            console.log("🟦 Paytm Passbook detected. Using Paytm parser.");
            return parsePaytmText(text);
        } else {
            console.log("📋 Generic format. Using fallback parser.");
            return parseReceiptText(text);
        }

    } catch (err) {
        console.error("❌ Local PDF Error:", err.message);
        return [];
    }
};

// ─── Process Images ───
const processImage = async (filePath) => {
    try {
        console.log("🛠️ Optimizing Image for OCR...");

        const image = await Jimp.read(filePath);
        image.greyscale().contrast(0.8).normalize();
        await image.write(filePath);

        console.log("⚙️ Running Local OCR Engine...");

        const { data: { text } } = await Tesseract.recognize(
            filePath,
            'eng',
            {
                tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz₹Rs.,- #',
                logger: m => { if (m.status === 'recognizing') console.log(`📊 Progress: ${Math.round(m.progress * 100)}%`); }
            }
        );

        if (!text || text.trim().length < 10) {
            console.warn("⚠️ Failed to extract text. Image may be too blurry.");
            return [];
        }

        console.log("🎯 Text Extracted. Parsing...");

        const isPaytm = /Passbook|Paytm|Money sent to|Bill Payment for/i.test(text);
        return isPaytm ? parsePaytmText(text) : parseReceiptText(text);

    } catch (err) {
        console.error("❌ OCR Error:", err.message);
        return [];
    }
};

// ─── Main Entry Point ───
const processDocument = async (filePath) => {
    if (!fs.existsSync(filePath)) return [];

    const ext = path.extname(filePath).toLowerCase();
    let transactions = [];

    console.log(`🚀 Processing ${ext} file...`);

    if (ext === '.pdf') {
        transactions = await processPDF(filePath);
    } else {
        transactions = await processImage(filePath);
    }

    const validated = transactions.filter(tx => tx && tx.amount > 0);
    console.log(`✅ Success: Found ${validated.length} transaction(s).`);
    return validated;
};

module.exports = processDocument;