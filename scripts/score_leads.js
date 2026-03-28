import fs from 'fs';
import path from 'fs';

// ICP Criteria
const TARGET_TITLES = ['CEO', 'CTO', 'Founder', 'Marketing Director', 'Owner', 'Managing Partner'];
const FORBIDDEN_WORDS = ['student', 'intern', 'freelancer', 'assistant'];

const LEADS_FILE = '/home/moltbot/clawd/data/leads.csv';
const HIGH_VALUE_FILE = '/home/moltbot/clawd/data/high_value_leads.json';

const MISSION_CONTROL_API = 'http://localhost:7004/api';
const MC_API_KEY = process.env.MC_API_KEY;

async function scoreLeads() {
  console.log('💎 Starting Lead Scoring Engine...');
  
  if (!fs.existsSync(LEADS_FILE)) {
    console.log('❌ No leads.csv found at ' + LEADS_FILE);
    return;
  }

  const data = fs.readFileSync(LEADS_FILE, 'utf8');
  const lines = data.split('\n');
  const highValueLeads = [];

  for (const line of lines) {
    if (!line || line.trim() === '') continue;
    
    // Format: domain,title,name,email
    const [domain, title, name, email] = line.split(',');
    if (!title || !name) continue;

    let score = 0;
    const lowerTitle = title.toLowerCase();

    if (TARGET_TITLES.some(t => lowerTitle.includes(t.toLowerCase()))) score += 50;
    if (FORBIDDEN_WORDS.some(w => lowerTitle.includes(w.toLowerCase()))) score -= 100;

    if (score >= 50) {
      console.log(`✅ High Value: ${name} (${title}) at ${domain}`);
      highValueLeads.push({ domain, title, name, email, score });
    }
  }

  // Save results
  fs.writeFileSync(HIGH_VALUE_FILE, JSON.stringify(highValueLeads, null, 2));
  console.log(`📝 Saved ${highValueLeads.length} high value leads to ${HIGH_VALUE_FILE}`);

  // Sync to Mission Control
  for (const lead of highValueLeads) {
    await fetch(`${MISSION_CONTROL_API}/tasks`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'x-api-key': MC_API_KEY
      },
      body: JSON.stringify({
        title: `💎 High Value: ${lead.name}`,
        description: `Lead Score: ${lead.score}. Title: ${lead.title}. Company: ${lead.domain}`,
        priority: 'high',
        status: 'todo',
        tags: ['high-value-lead', 'sales-pipeline'],
        metadata: { ...lead, source: 'lead-scorer' }
      })
    });
  }
}

scoreLeads();
