const puppeteer = require('puppeteer');

const CHART_COLORS = ['#d4a843', '#1fff8e', '#3dc8ff', '#ff4f6e', '#a78bfa', '#f97316', '#facc15', '#06b6d4', '#84cc16'];

// ── Build category totals ──
const buildCategoryData = (transactions) => {
    const cats = {};
    transactions.forEach(tx => {
        const cat = tx.category || 'Others';
        cats[cat] = (cats[cat] || 0) + (Number(tx.amount) || 0);
    });
    return Object.entries(cats)
        .map(([name, value]) => ({ name, value: Math.round(value) }))
        .sort((a, b) => b.value - a.value);
};

// ── Build monthly trend (last 6 months) ──
const buildMonthlyData = (transactions) => {
    const monthMap = {};
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const key = `${d.toLocaleString('default', { month: 'short' })} ${d.getFullYear()}`;
        monthMap[key] = 0;
    }
    transactions.forEach(tx => {
        const d = new Date(tx.date);
        const key = `${d.toLocaleString('default', { month: 'short' })} ${d.getFullYear()}`;
        if (key in monthMap) monthMap[key] += Number(tx.amount) || 0;
    });
    return Object.entries(monthMap).map(([label, amount]) => ({ label, amount: Math.round(amount) }));
};

// ── Generate SVG pie chart ──
const generatePieSVG = (data, total) => {
    if (!data.length) return '<text x="150" y="150" text-anchor="middle" fill="#555" font-size="14">No data</text>';

    const cx = 150, cy = 150, r = 110, innerR = 65;
    let paths = '';
    let angle = -Math.PI / 2;

    data.forEach((d, i) => {
        const slice = (d.value / total) * 2 * Math.PI;
        const x1 = cx + r * Math.cos(angle);
        const y1 = cy + r * Math.sin(angle);
        const x2 = cx + r * Math.cos(angle + slice);
        const y2 = cy + r * Math.sin(angle + slice);
        const xi1 = cx + innerR * Math.cos(angle);
        const yi1 = cy + innerR * Math.sin(angle);
        const xi2 = cx + innerR * Math.cos(angle + slice);
        const yi2 = cy + innerR * Math.sin(angle + slice);
        const largeArc = slice > Math.PI ? 1 : 0;
        const color = CHART_COLORS[i % CHART_COLORS.length];

        paths += `<path d="M${xi1},${yi1} L${x1},${y1} A${r},${r} 0 ${largeArc},1 ${x2},${y2} L${xi2},${yi2} A${innerR},${innerR} 0 ${largeArc},0 ${xi1},${yi1} Z" fill="${color}" opacity="0.92"/>`;
        angle += slice;
    });

    return paths;
};

// ── Generate SVG bar chart ──
const generateBarSVG = (data) => {
    if (!data.length) return '<text x="200" y="100" text-anchor="middle" fill="#555" font-size="14">No data</text>';

    const maxVal = Math.max(...data.map(d => d.amount), 1);
    const chartH = 140, chartW = 380, barW = Math.min(36, (chartW / data.length) - 6);
    const gap = chartW / data.length;
    let bars = '';

    data.forEach((d, i) => {
        const barH = Math.max((d.amount / maxVal) * chartH, 2);
        const x = i * gap + gap / 2 - barW / 2;
        const y = chartH - barH;
        const color = d.amount > 0 ? '#d4a843' : '#1e1e1e';

        bars += `
            <rect x="${x}" y="${y}" width="${barW}" height="${barH}" fill="${color}" rx="3" opacity="0.9"/>
            <text x="${x + barW / 2}" y="${chartH + 14}" text-anchor="middle" fill="#555" font-size="9" font-family="monospace">${d.label}</text>
        `;

        if (d.amount > 0) {
            const valLabel = d.amount >= 1000 ? `${(d.amount / 1000).toFixed(1)}k` : `${d.amount}`;
            bars += `<text x="${x + barW / 2}" y="${y - 4}" text-anchor="middle" fill="#888" font-size="8" font-family="monospace">${valLabel}</text>`;
        }
    });

    return bars;
};

// ── Main HTML template ──
const buildReportHTML = (transactions, userName) => {
    const total     = transactions.reduce((s, tx) => s + (Number(tx.amount) || 0), 0);
    const avgTx     = transactions.length ? total / transactions.length : 0;
    const topTx     = transactions.length ? [...transactions].sort((a, b) => b.amount - a.amount)[0] : null;
    const catData   = buildCategoryData(transactions);
    const monthData = buildMonthlyData(transactions);
    const pieTotal  = catData.reduce((s, d) => s + d.value, 0);
    const piePaths  = generatePieSVG(catData, pieTotal);
    const barPaths  = generateBarSVG(monthData);
    const now       = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });

    const categoryLegend = catData.map((d, i) => `
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
            <div style="width:10px;height:10px;border-radius:50%;background:${CHART_COLORS[i % CHART_COLORS.length]};flex-shrink:0;"></div>
            <span style="font-size:11px;color:#888;flex:1;">${d.name}</span>
            <span style="font-size:11px;color:#d4a843;font-family:monospace;">₹${d.value.toLocaleString('en-IN')}</span>
            <span style="font-size:10px;color:#444;font-family:monospace;margin-left:4px;">${pieTotal > 0 ? ((d.value / pieTotal) * 100).toFixed(1) : 0}%</span>
        </div>
    `).join('');

    const txRows = transactions.slice(0, 50).map((tx, i) => `
        <tr style="background:${i % 2 === 0 ? '#0f0f0f' : '#111'};">
            <td style="padding:9px 12px;color:#f0ece4;font-size:12px;border-bottom:1px solid #1a1a1a;">${tx.recipient || 'Unknown'}</td>
            <td style="padding:9px 12px;font-size:11px;border-bottom:1px solid #1a1a1a;">
                <span style="background:rgba(167,139,250,0.1);color:#a78bfa;padding:2px 8px;border-radius:4px;font-size:10px;">${tx.category || 'Others'}</span>
            </td>
            <td style="padding:9px 12px;color:#ff4f6e;font-size:12px;font-family:monospace;text-align:right;border-bottom:1px solid #1a1a1a;">−₹${Number(tx.amount).toLocaleString('en-IN')}</td>
            <td style="padding:9px 12px;color:#555;font-size:11px;border-bottom:1px solid #1a1a1a;">${tx.dateTime || (tx.date ? new Date(tx.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '')}</td>
        </tr>
    `).join('');

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #080808; color: #f0ece4; font-family: 'Segoe UI', Arial, sans-serif; padding: 40px; }
  .page-break { page-break-before: always; }
</style>
</head>
<body>

  <!-- ── HEADER ── -->
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:36px;padding-bottom:24px;border-bottom:1px solid #1a1a1a;">
    <div>
      <div style="font-size:28px;font-weight:900;letter-spacing:3px;color:#f0ece4;">DR. FINANCE <span style="color:#d4a843;">AI</span></div>
      <div style="font-size:11px;color:#444;letter-spacing:2px;margin-top:4px;font-family:monospace;">PERSONAL EXPENSE REPORT</div>
    </div>
    <div style="text-align:right;">
      <div style="font-size:12px;color:#555;font-family:monospace;">Generated for</div>
      <div style="font-size:14px;color:#d4a843;margin-top:2px;">${userName || 'User'}</div>
      <div style="font-size:11px;color:#444;margin-top:2px;font-family:monospace;">${now}</div>
    </div>
  </div>

  <!-- ── STAT CARDS ── -->
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:32px;">
    <div style="background:#0f0f0f;border:1px solid #1a1a1a;border-radius:12px;padding:20px;">
      <div style="font-size:10px;color:#444;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:10px;font-family:monospace;">Total Outflow</div>
      <div style="font-size:28px;font-weight:800;color:#d4a843;">₹${total.toLocaleString('en-IN')}</div>
    </div>
    <div style="background:#0f0f0f;border:1px solid #1a1a1a;border-radius:12px;padding:20px;">
      <div style="font-size:10px;color:#444;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:10px;font-family:monospace;">Transactions</div>
      <div style="font-size:28px;font-weight:800;color:#1fff8e;">${transactions.length}</div>
    </div>
    <div style="background:#0f0f0f;border:1px solid #1a1a1a;border-radius:12px;padding:20px;">
      <div style="font-size:10px;color:#444;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:10px;font-family:monospace;">Avg Ticket</div>
      <div style="font-size:28px;font-weight:800;color:#3dc8ff;">₹${Math.round(avgTx).toLocaleString('en-IN')}</div>
    </div>
  </div>

  <!-- ── CHARTS ROW ── -->
  <div style="display:grid;grid-template-columns:300px 1fr;gap:20px;margin-bottom:32px;">

    <!-- Pie Chart -->
    <div style="background:#0f0f0f;border:1px solid #1a1a1a;border-radius:12px;padding:20px;">
      <div style="font-size:10px;color:#444;letter-spacing:0.14em;text-transform:uppercase;margin-bottom:16px;font-family:monospace;">Category Breakdown</div>
      <svg width="300" height="300" viewBox="0 0 300 300" xmlns="http://www.w3.org/2000/svg">
        <rect width="300" height="300" fill="#0f0f0f"/>
        ${piePaths}
        <circle cx="150" cy="150" r="55" fill="#0f0f0f"/>
        <text x="150" y="144" text-anchor="middle" fill="#d4a843" font-size="13" font-weight="bold" font-family="monospace">₹${total >= 1000 ? (total / 1000).toFixed(1) + 'k' : total}</text>
        <text x="150" y="160" text-anchor="middle" fill="#444" font-size="9" font-family="monospace">TOTAL</text>
      </svg>
      <div style="margin-top:12px;">${categoryLegend}</div>
    </div>

    <!-- Bar Chart -->
    <div style="background:#0f0f0f;border:1px solid #1a1a1a;border-radius:12px;padding:20px;">
      <div style="font-size:10px;color:#444;letter-spacing:0.14em;text-transform:uppercase;margin-bottom:16px;font-family:monospace;">Monthly Spending Trend (Last 6 Months)</div>
      <svg width="420" height="200" viewBox="0 0 420 180" xmlns="http://www.w3.org/2000/svg">
        <rect width="420" height="180" fill="#0f0f0f"/>
        <!-- Grid lines -->
        <line x1="0" y1="35" x2="420" y2="35" stroke="#1a1a1a" stroke-width="1"/>
        <line x1="0" y1="70" x2="420" y2="70" stroke="#1a1a1a" stroke-width="1"/>
        <line x1="0" y1="105" x2="420" y2="105" stroke="#1a1a1a" stroke-width="1"/>
        <line x1="0" y1="140" x2="420" y2="140" stroke="#1a1a1a" stroke-width="1"/>
        <g transform="translate(20, 0)">${barPaths}</g>
      </svg>
      ${topTx ? `
      <div style="margin-top:16px;padding:14px;background:#111;border-radius:8px;border:1px solid #1a1a1a;">
        <div style="font-size:9px;color:#444;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:6px;font-family:monospace;">Highest Transaction</div>
        <div style="font-size:22px;font-weight:800;color:#d4a843;">₹${Number(topTx.amount).toLocaleString('en-IN')}</div>
        <div style="font-size:12px;color:#555;margin-top:3px;">→ ${topTx.recipient}</div>
      </div>` : ''}
    </div>

  </div>

  <!-- ── TRANSACTION TABLE ── -->
  <div style="background:#0f0f0f;border:1px solid #1a1a1a;border-radius:12px;overflow:hidden;">
    <div style="padding:18px 20px;border-bottom:1px solid #1a1a1a;">
      <div style="font-size:10px;color:#444;letter-spacing:0.14em;text-transform:uppercase;font-family:monospace;">Transaction Log ${transactions.length > 50 ? '(showing latest 50)' : ''}</div>
    </div>
    <table style="width:100%;border-collapse:collapse;">
      <thead>
        <tr style="background:#111;">
          <th style="padding:10px 12px;text-align:left;font-size:10px;color:#444;letter-spacing:0.1em;text-transform:uppercase;font-weight:500;font-family:monospace;border-bottom:1px solid #1a1a1a;">Recipient</th>
          <th style="padding:10px 12px;text-align:left;font-size:10px;color:#444;letter-spacing:0.1em;text-transform:uppercase;font-weight:500;font-family:monospace;border-bottom:1px solid #1a1a1a;">Category</th>
          <th style="padding:10px 12px;text-align:right;font-size:10px;color:#444;letter-spacing:0.1em;text-transform:uppercase;font-weight:500;font-family:monospace;border-bottom:1px solid #1a1a1a;">Amount</th>
          <th style="padding:10px 12px;text-align:left;font-size:10px;color:#444;letter-spacing:0.1em;text-transform:uppercase;font-weight:500;font-family:monospace;border-bottom:1px solid #1a1a1a;">Date & Time</th>
        </tr>
      </thead>
      <tbody>${txRows}</tbody>
    </table>
  </div>

  <!-- ── FOOTER ── -->
  <div style="margin-top:28px;text-align:center;color:#333;font-size:11px;font-family:monospace;">
    Dr. Finance AI · Auto-generated report · Do not reply
  </div>

</body>
</html>`;
};

// ── Main export: generate PDF buffer ──
const generatePDFReport = async (transactions, userName) => {
    const html = buildReportHTML(transactions, userName);

    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });

        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '0px', right: '0px', bottom: '0px', left: '0px' }
        });

        return pdfBuffer;
    } finally {
        await browser.close();
    }
};

module.exports = generatePDFReport;
