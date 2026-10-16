#!/bin/sh
exec /usr/bin/chromium --no-sandbox --disable-dev-shm-usage --proxy-server=http://127.0.0.1:3128 '--proxy-bypass-list=<-loopback>' "$@"
