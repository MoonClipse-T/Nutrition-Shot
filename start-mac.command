#!/bin/bash
cd "$(dirname "$0")"
echo ""
echo "  Project_Godeok 서버를 시작합니다..."
echo "  (이 창을 닫으면 게임이 끊깁니다. 수업이 끝날 때까지 켜 두세요)"
echo ""

NODEBIN=""
if command -v node >/dev/null 2>&1; then
  NODEBIN="$(command -v node)"
elif [ -x "./node" ]; then
  NODEBIN="./node"
elif [ -x "/usr/local/bin/node" ]; then
  NODEBIN="/usr/local/bin/node"
elif [ -x "/opt/homebrew/bin/node" ]; then
  NODEBIN="/opt/homebrew/bin/node"
fi

if [ -z "$NODEBIN" ]; then
  echo "  ============================================================"
  echo "   [!] Node.js 를 찾지 못했습니다."
  echo "  ============================================================"
  echo ""
  echo "   https://nodejs.org 에서 초록색 LTS 버튼을 눌러 설치한 뒤"
  echo "   터미널 창을 닫았다가 이 파일을 다시 실행해 주세요."
  echo ""
  read -n 1 -s -r -p "  아무 키나 누르면 닫힙니다..."
  exit 1
fi

echo "  Node.js 찾음: $NODEBIN"
echo ""
"$NODEBIN" server.js
