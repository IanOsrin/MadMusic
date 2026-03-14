#!/bin/bash
# Run SonarQube scan for MASS Music project
set -e

PROJECT_DIR="/Users/ianosrin/Downloads/madmusic"
SONAR_HOST="http://localhost:9000"
PROJECT_KEY="madmusic"

echo "🔍 Setting up SonarQube scan for MASS Music..."

# Prompt for credentials
read -p "SonarQube username (default: admin): " SONAR_USER
SONAR_USER=${SONAR_USER:-admin}
read -s -p "SonarQube password: " SONAR_PASS
echo ""

# Create project if it doesn't exist
echo "📁 Creating project if needed..."
curl -s -u "$SONAR_USER:$SONAR_PASS" -X POST \
  "$SONAR_HOST/api/projects/create?name=MASS+Music&project=$PROJECT_KEY" \
  > /dev/null 2>&1 || true

# Generate a token
echo "🔑 Generating scan token..."
TOKEN_RESPONSE=$(curl -s -u "$SONAR_USER:$SONAR_PASS" -X POST \
  "$SONAR_HOST/api/user_tokens/generate?name=madmusic-scan-$(date +%s)")

TOKEN=$(echo "$TOKEN_RESPONSE" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

if [ -z "$TOKEN" ]; then
  echo "❌ Failed to generate token. Check your credentials."
  exit 1
fi

echo "✅ Token generated."

# Run the scan
echo "🚀 Running sonar-scanner..."
cd "$PROJECT_DIR"
sonar-scanner -Dsonar.token="$TOKEN"

echo ""
echo "✅ Scan complete! View results at: $SONAR_HOST/dashboard?id=$PROJECT_KEY"
