const nodemailer = require('nodemailer');
const generatePDFReport = require('./reportGenerator');
require('dotenv').config();

const sendEmailReport = async (userEmail, transactions, userName) => {
    try {
        if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
            console.warn("⚠️ EMAIL_USER or EMAIL_PASS not set in .env — skipping email.");
            return;
        }

        if (!userEmail || !userEmail.includes('@')) {
            console.warn("⚠️ Invalid email address — skipping.");
            return;
        }

        console.log(`📧 Generating PDF report for ${userEmail}...`);

        const pdfBuffer = await generatePDFReport(transactions, userName || userEmail);
        const total = transactions.reduce((s, tx) => s + (Number(tx.amount) || 0), 0);
        const now   = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });

        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS,
            }
        });

        const mailOptions = {
            from: `"Dr. Finance AI" <${process.env.EMAIL_USER}>`,
            to: userEmail,
            subject: `Your Expense Report — Rs.${total.toLocaleString('en-IN')} · ${now}`,
            html: `
                <div style="background:#080808;padding:40px;font-family:'Segoe UI',Arial,sans-serif;max-width:520px;margin:0 auto;">
                    <div style="font-size:22px;font-weight:900;letter-spacing:2px;color:#f0ece4;margin-bottom:4px;">
                        DR. FINANCE <span style="color:#d4a843;">AI</span>
                    </div>
                    <div style="font-size:11px;color:#444;letter-spacing:2px;font-family:monospace;margin-bottom:28px;">EXPENSE REPORT READY</div>
                    <div style="background:#0f0f0f;border:1px solid #1a1a1a;border-radius:12px;padding:24px;margin-bottom:20px;">
                        <div style="font-size:12px;color:#555;font-family:monospace;margin-bottom:6px;">TOTAL PROCESSED</div>
                        <div style="font-size:32px;font-weight:800;color:#d4a843;">Rs.${total.toLocaleString('en-IN')}</div>
                        <div style="font-size:12px;color:#444;margin-top:6px;">${transactions.length} transaction(s) found in your document</div>
                    </div>
                    <div style="font-size:13px;color:#666;line-height:1.6;margin-bottom:20px;">
                        Your full expense report is attached as a PDF. It includes your category breakdown, monthly trend chart, and complete transaction log.
                    </div>
                    <div style="border-top:1px solid #1a1a1a;padding-top:16px;text-align:center;font-size:11px;color:#333;font-family:monospace;">
                        Dr. Finance AI · Auto-generated · Do not reply
                    </div>
                </div>
            `,
            attachments: [
                {
                    filename: `DrFinance_Report_${new Date().toISOString().split('T')[0]}.pdf`,
                    content: pdfBuffer,
                    contentType: 'application/pdf'
                }
            ]
        };

        await transporter.sendMail(mailOptions);
        console.log(`✅ PDF report emailed to ${userEmail}`);

    } catch (error) {
        console.error("❌ Email Error:", error.message);
    }
};

module.exports = sendEmailReport;
