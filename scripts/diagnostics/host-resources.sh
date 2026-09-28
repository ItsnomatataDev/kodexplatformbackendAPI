#!/usr/bin/env bash
# Read-only Linux host snapshot. Run on the Kode host, outside the API container.
set -u
uptime
free -h
df -hT
df -i
ps -eo pid,comm,pcpu,pmem,rss --sort=-rss | head -n 16
if command -v docker >/dev/null 2>&1; then
  docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.BlockIO}}'
  docker system df
fi
