#!/usr/bin/env bash
# hermes-monitor-g3.sh — polls G3 ticket completion + LightRAG ingest progress on 6900XT.
# Prints a compact status line. Non-blocking, for periodic checks.
cd /home/hh/athena-agent 2>/dev/null || exit 1

echo "=== $(date +%T) ==="

# G3 tickets status
for t in S1/T1 S1/T2 S1/T3 S1/T4 S2/T1 S2/T2 S2/T3 S2/T4 S3/T1 S3/T2 S3/T3 S4/T1 S4/T2 S4/T3 S4/T4 S5/T1 S5/T2 S5/T3 S6/T1 S6/T2 S6/T3 S6/T4 S6/T5 S6/T6; do
  if [ -f "docs/kanban/G3/$t.md" ]; then
    st=$(grep -E '^status:' "docs/kanban/G3/$t.md" | head -1 | cut -d: -f2 | xargs)
    echo "  G3.$t: $st"
  fi
done

# LightRAG GroupReporting progress
echo "--- LightRAG ---"
grep -E 'Chunk [0-9]+ of 182|Failed to extract document' ~/lightrag/lightrag.log 2>/dev/null | tail -1
# doc status via API
curl -s 'http://localhost:9621/documents' 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); r=[(s.get('status'),s.get('error_msg','')[:40]) for st in d['statuses'].values() for s in st if 'Group' in s.get('file_path','')]; print('  GroupReporting doc:', r)" 2>&1 | head -1
