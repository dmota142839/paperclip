#!/usr/bin/env bash
# lead_scraper.sh - For Growth Hacker agent
# Usage: ./lead_scraper.sh "keyword" "location"

KEYWORDS=$1
LOCATION=$2
MISSION_CONTROL_API="http://localhost:7004/api"

# Load environment variables from .env
export $(grep -v '^#' "$(dirname "$0")/../.env" | xargs)

echo "🔍 Searching for leads: $KEYWORDS in $LOCATION..."

# In a real scenario, this would call a scraper API or use OpenClaw search tools.
# For this demo, we simulate finding a high-quality lead.

cat <<EOF > leads.json
[
  {
    "contact_name": "Jane Doe",
    "email": "jane.doe@example.com",
    "company": "TechInnovate",
    "profile_url": "https://linkedin.com/in/janedoe-demo",
    "reason": "Matching ICP: Scaling engineering team"
  }
]
EOF

# Loop through leads and push to Mission Control with special status 'lead_verified'
# to trigger the bridge's MarOps loop.

cat leads.json | jq -c '.[]' | while read lead; do
  NAME=$(echo $lead | jq -r '.contact_name')
  EMAIL=$(echo $lead | jq -r '.email')
  COMPANY=$(echo $lead | jq -r '.company')
  URL=$(echo $lead | jq -r '.profile_url')

  echo "✅ Verifying Lead: $NAME ($COMPANY)"
  
  curl -s -X POST "$MISSION_CONTROL_API/tasks" \
    -H "Content-Type: application/json" \
    -H "x-api-key: $MC_API_KEY" \
    -d "{
      \"title\": \"[Lead] $NAME at $COMPANY\",
      \"description\": \"Verified LinkedIn Lead for $KEYWORDS. Ready for personalization.\",
      \"status\": \"lead_verified\",
      \"assigned_to\": \"Growth Hacker\",
      \"metadata\": {
        \"contact_name\": \"$NAME\",
        \"email\": \"$EMAIL\",
        \"company\": \"$COMPANY\",
        \"linkedin\": \"$URL\"
      },
      \"tags\": [\"marops-lead\", \"growth-hacker\"]
    }" > /dev/null
done

rm leads.json
echo "🏁 Lead processing complete."
