#!/bin/bash

##############################################################################
# FileMaker Connection Diagnostics
#
# Run: chmod +x scripts/diagnose-filemaker-connection.sh
#      ./scripts/diagnose-filemaker-connection.sh
##############################################################################

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║       FileMaker Server Connection Diagnostics                  ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# Load .env file if it exists
if [ -f .env ]; then
    echo "✓ Found .env file"
    export $(cat .env | grep -v '^#' | xargs)
else
    echo "⚠️  No .env file found"
fi

echo ""
echo "📋 Configuration Check:"
echo "─────────────────────────────────────────────────────────────────"
echo "FM_HOST: ${FM_HOST:-NOT SET}"
echo "FM_DB: ${FM_DB:-NOT SET}"
echo "FM_USER: ${FM_USER:-NOT SET}"
echo "FM_PASS: ${FM_PASS:+***SET***}"
echo ""

# Extract host from FM_HOST
if [ -z "$FM_HOST" ]; then
    echo "❌ FM_HOST not set in .env"
    exit 1
fi

# Parse hostname from URL
FM_HOSTNAME=$(echo $FM_HOST | sed -e 's|^https\?://||' -e 's|/.*$||' -e 's|:.*$||')
FM_PORT=$(echo $FM_HOST | grep -oP ':\K[0-9]+' || echo "443")

echo "🌐 Network Connectivity:"
echo "─────────────────────────────────────────────────────────────────"
echo "Target: $FM_HOSTNAME:$FM_PORT"
echo ""

# Test DNS resolution
echo -n "DNS resolution... "
if host $FM_HOSTNAME > /dev/null 2>&1; then
    IP=$(host $FM_HOSTNAME | grep "has address" | awk '{print $4}' | head -1)
    echo "✓ Resolved to $IP"
else
    echo "❌ DNS resolution failed"
fi

# Test port connectivity
echo -n "Port $FM_PORT connectivity... "
if nc -z -w5 $FM_HOSTNAME $FM_PORT 2>/dev/null; then
    echo "✓ Port is reachable"
else
    echo "❌ Port is not reachable"
fi

# Test HTTPS connection
echo -n "HTTPS connection... "
if curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$FM_HOST" > /dev/null 2>&1; then
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$FM_HOST")
    echo "✓ HTTP Status: $HTTP_CODE"
else
    echo "❌ HTTPS connection failed"
fi

echo ""
echo "🔌 Port 8989 Issue Investigation:"
echo "─────────────────────────────────────────────────────────────────"
echo "Your logs show: 'connect ECONNREFUSED 127.0.0.1:8989'"
echo "This suggests FileMaker Server is trying to connect to a local service."
echo ""

echo -n "Checking if port 8989 is in use... "
if lsof -i :8989 > /dev/null 2>&1; then
    echo "✓ Port 8989 is in use"
    echo ""
    lsof -i :8989
else
    echo "❌ Nothing listening on port 8989"
    echo ""
    echo "⚠️  This is likely the issue!"
    echo ""
    echo "Possible causes:"
    echo "  1. FileMaker Server has an external data source configured for 127.0.0.1:8989"
    echo "  2. A FileMaker plugin or ODBC/JDBC connection is misconfigured"
    echo "  3. An external authentication service isn't running"
    echo ""
    echo "🔧 Recommended actions:"
    echo "  1. Check FileMaker Server Admin Console → Database Server → External Data Sources"
    echo "  2. Look for any data sources pointing to localhost:8989"
    echo "  3. Disable or fix the misconfigured external data source"
    echo "  4. Check FileMaker Server error logs in:"
    echo "     - macOS: /Library/FileMaker Server/Logs/"
    echo "     - Windows: C:\\Program Files\\FileMaker\\FileMaker Server\\Logs\\"
fi

echo ""
echo "🧪 FileMaker Data API Test:"
echo "─────────────────────────────────────────────────────────────────"
echo "Testing Data API authentication..."
echo ""

# Test Data API endpoint
API_URL="${FM_HOST}/fmi/data/v1/databases"
echo "Testing: $API_URL"
echo ""

HTTP_RESPONSE=$(curl -s -w "\nHTTP_STATUS:%{http_code}" "$API_URL" 2>&1)
HTTP_STATUS=$(echo "$HTTP_RESPONSE" | grep "HTTP_STATUS:" | cut -d: -f2)

if [ "$HTTP_STATUS" = "200" ]; then
    echo "✓ FileMaker Data API is accessible"
elif [ "$HTTP_STATUS" = "401" ]; then
    echo "✓ FileMaker Data API is accessible (authentication required - expected)"
else
    echo "⚠️  HTTP Status: $HTTP_STATUS"
    echo "$HTTP_RESPONSE"
fi

echo ""
echo "📊 Performance Recommendations:"
echo "─────────────────────────────────────────────────────────────────"
echo "1. ⚠️  Fix port 8989 issue (causing timeouts/retries)"
echo "2. 📇 Index critical fields (see FILEMAKER_INDEX_CHECKLIST.md)"
echo "3. 🔧 Optimize FileMaker layouts (remove unnecessary calculations)"
echo "4. 💾 Increase FileMaker Server cache size"
echo "5. 🌐 Ensure low network latency between Node.js and FileMaker"
echo ""

echo "✅ Diagnostics complete!"
echo ""
echo "📝 Next steps:"
echo "   1. Review the port 8989 issue above"
echo "   2. Check FileMaker Server Admin Console for external data sources"
echo "   3. Run: node scripts/analyze-query-performance.js"
echo "   4. Index the critical fields listed in FILEMAKER_INDEX_CHECKLIST.md"
echo ""
