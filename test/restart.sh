#!/bin/sh
# 개발용: 서버를 깨끗하게 재시작한다
for p in $(ps -eo pid,args | grep '[n]ode server.js' | awk '{print $1}'); do
  kill "$p" 2>/dev/null
done
sleep 2
cd /root/godeok || exit 1
setsid nohup node server.js > /tmp/srv.log 2>&1 < /dev/null &
sleep 3
grep "정답" /tmp/srv.log | tail -1
