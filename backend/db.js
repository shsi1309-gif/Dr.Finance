const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY; // service_role key for backend

if (!supabaseUrl || !supabaseKey) {
    console.error("❌ SUPABASE_URL or SUPABASE_SERVICE_KEY missing in .env");
    process.exit(1);
}
else{
    console.log("Database connected");
}

const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = supabase;