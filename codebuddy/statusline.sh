#!/bin/bash
# 由现有 statusLine 脚本在输出主状态行后调用；仅读取展示缓存。
codebuddy_cache="${USERPROFILE:-$HOME}/.claude/codebuddy/usage.json"
if [[ -r "$codebuddy_cache" ]]; then
  jq -r '
    if (.text | type) == "string" and (.updatedAt | type) == "number"
       and ((now * 1000 - .updatedAt) < 180000)
    then .text
    else "token usage · today -- · remain --/--"
    end
  ' "$codebuddy_cache" 2>/dev/null || printf '%s\n' 'token usage · today -- · remain --/--'
else
  printf '%s\n' 'token usage · today -- · remain --/--'
fi
