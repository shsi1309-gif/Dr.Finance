# 💰 Dr. Finance AI

**AI-Powered Personal Expense Tracker**  
Full-Stack Web Application · Version 1.0

---

## 🚀 Project Overview

**Dr. Finance AI** is a full-stack personal finance tracker that allows users to:

- 📤 Upload payment screenshots or bank statement PDFs  
- 🔍 Automatically extract transactions using OCR + AI  
- 📊 Visualize spending patterns via interactive charts  
- 🤖 Generate personalized financial plans using AI  
- 📧 Receive detailed PDF reports via email  

👉 The system eliminates **manual expense entry** completely.

---

## ✨ Key Features

- OCR-based transaction extraction (images + PDFs)  
- AI-powered financial advisor (Llama 3.1)  
- Automatic expense categorization (9 categories)  
- Interactive charts (Pie + Bar)  
- Secure authentication (JWT + bcrypt)  
- Email PDF reports  
- Real-time stock recommendations  

---

## 🛠️ Tech Stack

### Frontend
- React.js  
- Recharts  

### Backend
- Node.js  
- Express.js  

### Database
- Supabase (PostgreSQL)  

### AI & Processing
- OpenRouter (Llama 3.1)  
- Tesseract.js (OCR)  
- Puppeteer (PDF generation)  

### Other Tools
- Nodemailer  
- JWT  
- Bcrypt  
- Multer  

---

## 📂 Project Structure

```
financetracker/
│
├── App.jsx              # Frontend UI
├── server.js            # Backend API
├── db.js                # Supabase config
├── ocrProcessor.js      # OCR + parsing
├── emailService.js      # Email sender
├── reportGenerator.js   # PDF generator
└── .env                 # Environment variables
```

## ⚙️ Installation & Setup

### 1️⃣ Clone the repository

```bash
git clone https://github.com/your-username/your-repo.git
cd your-repo
2️⃣ Install dependencies
npm install
3️⃣ Setup environment variables

Create a .env file:

SUPABASE_URL=your_url
SUPABASE_SERVICE_KEY=your_key
JWT_SECRET=your_secret
EMAIL_USER=your_email
EMAIL_PASS=your_app_password
OPENROUTER_API_KEY=your_key
FRONTEND_URL=http://localhost:5173
PORT=5001

⚠️ Never upload .env to GitHub

4️⃣ Setup database (Supabase)

Run SQL in Supabase:

CREATE TABLE users (
  id UUID PRIMARY KEY,
  name TEXT,
  email TEXT UNIQUE,
  password TEXT
);

CREATE TABLE transactions (
  id UUID PRIMARY KEY,
  user_id UUID,
  amount NUMERIC,
  category TEXT
);
5️⃣ Start server
node server.js
🔐 Authentication System
JWT-based authentication
Password hashing using bcrypt
Secure login, register, forgot-password flow
📄 Document Processing Pipeline
Upload file (PDF/Image)
OCR extraction (Tesseract.js)
Text parsing
Transaction extraction
Category classification
Store in database
Generate report
📊 Data Visualization
Pie Chart
Category-wise expense breakdown
Bar Chart
Monthly / yearly spending trends
📧 Email Reports
Auto-generated PDF reports
Sent using Nodemailer
Includes charts + transaction table
🤖 AI Financial Advisor
Uses Llama 3.1 via OpenRouter
Analyzes last 30 days spending
Suggests:
Savings plan
Expense cuts
Stock recommendations
🔌 API Endpoints
Method	Endpoint	Description
POST	/api/auth/register	Register user
POST	/api/auth/login	Login
GET	/api/transactions	Get transactions
POST	/api/upload	Upload file
POST	/api/ai/advisor	AI financial plan
🔒 Security Features
JWT authentication
Bcrypt password hashing
Secure file upload validation
User data isolation
Token-based password reset
🧪 Troubleshooting
Error	Fix
Email not sending	Check Gmail App Password
AI not working	Check OpenRouter API key
No transactions found	Invalid PDF format
