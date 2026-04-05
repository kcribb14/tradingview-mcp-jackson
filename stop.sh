#!/bin/bash
lsof -ti:3000 | xargs kill 2>/dev/null
echo "Dashboard stopped"
