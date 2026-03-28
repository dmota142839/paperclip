import express from 'express';
import fetch from 'node-fetch';
import { execSync } from 'child_process';

const app = express();
app.use(express.json());

const PAPERCLIP_API = 'http://localhost:7003/api';
const MISSION_CONTROL_API = 'http://localhost:7004/api';
const MC_API_KEY = process.env.MC_API_KEY;
const WEBHOOK_PORT = 7005;

// Thresholds
const THRESHOLD = 90; 
const REBOOT_THRESHOLD = 95; 
const STUCK_MINUTES = 5; 

// State
let lastRebootTime = 0;
let lastHeartbeatTime = Date.now();
let repetitionCounter = 0;
let lastMessage = "";
const REBOOT_COOLDOWN = 10 * 60 * 1000; 
const syncedIds = new Set();

function recordActivity() {
  lastHeartbeatTime = Date.now();
}

function getSystemStats() {
  try {
    const gpuInfo = execSync('nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits').toString();
    const [used, total] = gpuInfo.split(',').map(Number);
    const gpuUsage = (used / total) * 100;
    const memInfo = execSync("free | grep Mem | awk '{print $3/$2 * 100.0}'").toString();
    const ramUsage = parseFloat(memInfo);
    return { gpuUsage, ramUsage };
  } catch (e) {
    return { gpuUsage: 0, ramUsage: 0, error: "Monitoring failed" };
  }
}

async function rebootLLMServices(reason = "Resource Redline") {
  const now = Date.now();
  if (now - lastRebootTime < REBOOT_COOLDOWN) return;
  console.log(`[Guardian] 🚨 SELF-HEALING: ${reason}.`);
  try {
    execSync('systemctl --user restart openclaw-gateway.service');
    lastRebootTime = now;
    repetitionCounter = 0;
  } catch (err) {}
}

async function getPaperclipAgents(companyId) {
  try {
    const res = await fetch(`${PAPERCLIP_API}/companies/${companyId}/agents`);
    if (!res.ok) return {};
    const agents = await res.json();
    const map = {};
    agents.forEach(a => { map[a.id] = a.name; });
    return map;
  } catch (err) { return {}; }
}

async function syncAll() {
  try {
    const { gpuUsage, ramUsage } = getSystemStats();
    const timeSinceActivity = (Date.now() - lastHeartbeatTime) / 1000 / 60;

    if (gpuUsage > 90 && timeSinceActivity > STUCK_MINUTES) {
      await rebootLLMServices(`Zombie Detected`);
    }

    if (gpuUsage > REBOOT_THRESHOLD || ramUsage > REBOOT_THRESHOLD) {
      await rebootLLMServices("Critical Redline");
    }

    const companiesRes = await fetch(`${PAPERCLIP_API}/companies`);
    if (!companiesRes.ok) return;
    const companies = await companiesRes.json();

    for (const company of companies) {
      const agentMap = await getPaperclipAgents(company.id);

      // Sync Goals
      const goalsRes = await fetch(`${PAPERCLIP_API}/companies/${company.id}/goals`);
      if (goalsRes.ok) {
        const goals = await goalsRes.json();
        if (goals.length > 0) recordActivity();
        for (const goal of goals) {
          const syncKey = `goal:${goal.id}`;
          if (syncedIds.has(syncKey)) continue;
          await fetch(`${MISSION_CONTROL_API}/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': MC_API_KEY },
            body: JSON.stringify({
              title: `[Strategy] ${goal.title}`,
              description: goal.description,
              priority: 'high',
              status: 'assigned',
              metadata: { paperclip_type: 'goal', paperclip_id: goal.id, company_id: company.id },
              tags: ['paperclip-goal', company.name]
            })
          });
          syncedIds.add(syncKey);
        }
      }

      // Sync Issues
      const issuesRes = await fetch(`${PAPERCLIP_API}/companies/${company.id}/issues`);
      if (issuesRes.ok) {
        const issues = await issuesRes.json();
        if (issues.length > 0) recordActivity();
        for (const issue of issues) {
          const syncKey = `issue:${issue.id}`;
          if (syncedIds.has(syncKey)) continue;
          const assigneeName = agentMap[issue.assigneeAgentId] || null;
          await fetch(`${MISSION_CONTROL_API}/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': MC_API_KEY },
            body: JSON.stringify({
              title: `[Task] ${issue.title}`,
              description: issue.description,
              priority: issue.priority || 'medium',
              status: 'assigned',
              assigned_to: assigneeName,
              metadata: { paperclip_type: 'issue', paperclip_id: issue.id, company_id: company.id },
              tags: ['paperclip-task', company.name]
            })
          });
          syncedIds.add(syncKey);
        }
      }
    }
  } catch (err) { console.error('[Sync Error]', err.message); }
}

// Webhook Listener
app.post('/mc-webhook', async (req, res) => {
  const { task, event, agent } = req.body;
  
  if (task) {
    recordActivity();

    // 1. MarOps Loop: Lead verified -> Content Personalization
    // (Triggered when Growth Hacker moves a lead task to 'lead_verified' status)
    if (task.status === 'lead_verified' && task.metadata?.email) {
      console.log(`📨 [MarOps] Lead found: ${task.metadata.email}. Tasking Content Creator...`);
      await fetch(`${MISSION_CONTROL_API}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': MC_API_KEY },
        body: JSON.stringify({
          title: `Personalize Outreach: ${task.metadata.contact_name || task.metadata.email}`,
          description: `Personalize first-touch email for ${task.metadata.company || 'Unknown'}. Lead Profile: ${task.metadata.linkedin || 'N/A'}`,
          priority: "medium",
          assigned_to: "Content Creator",
          metadata: { ...task.metadata, source_task_id: task.id },
          tags: ['marops-outreach']
        })
      });
    }

    // 2. Hallucination Detection
    const currentMsg = task.description;
    if (currentMsg === lastMessage && currentMsg !== "") {
      repetitionCounter++;
    } else {
      repetitionCounter = 0;
      lastMessage = currentMsg;
    }
    if (repetitionCounter > 10) {
      await rebootLLMServices("Infinite Loop Detected");
    }

    // 3. Reverse Sync to Paperclip
    if (task.status === 'done' && task.metadata?.paperclip_id) {
      const { paperclip_id, paperclip_type, company_id } = task.metadata;
      try {
        await fetch(`${PAPERCLIP_API}/companies/${company_id}/${paperclip_type === 'goal' ? 'goals' : 'issues'}/${paperclip_id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'done' })
        });
      } catch (err) {}
    }
  }
  res.sendStatus(200);
});

app.listen(WEBHOOK_PORT, () => {
  console.log(`[Webhook] Listening on port ${WEBHOOK_PORT}`);
});

syncAll();
setInterval(syncAll, 30000);
console.log('Paperclip <-> Mission Control Bridge: MarOps Engine & Self-Healing Active');
