# One prompt for zsh, PowerShell and cmd on Windows, with Windows paths.
#
# Windows programs (ipconfig, winget, node, claude) already run from zsh
# because the Windows PATH is inherited. Three things need help, and this file
# handles them when Enter is pressed:
#
#  1. PowerShell cmdlets. When the first word is not a zsh command or a
#     program on PATH and looks like a cmdlet (Get-Process, $env:X, [Type]),
#     the whole line runs in PowerShell, so `Get-Process | Where-Object CPU
#     -gt 100` keeps its PowerShell meaning.
#  2. cmd built-ins (copy, del, ren, md, rd, mklink, start, ver, ...) run in
#     cmd. A name zsh knows, such as dir, echo or set, stays zsh's.
#  3. Windows paths. An unquoted C:\Users\me becomes C:/Users/me, which MSYS2
#     accepts; without this zsh reads each backslash as an escape.
#
# The screen and the history show the line as it was typed.

typeset -gA __byndery_cmd_builtins=(
  assoc 1 cls 1 color 1 copy 1 del 1 erase 1 ftype 1 md 1 mklink 1 move 1
  rd 1 ren 1 rename 1 start 1 title 1 ver 1 vol 1
)
typeset -g __byndery_typed=''
typeset -g __byndery_ran=''

# Full paths, because the inherited PATH can be missing System32 entries and
# Cygwin-style lookup is slower than a direct exec.
() {
  local root=${SYSTEMROOT:-${SystemRoot:-C:\\Windows}}
  root="/${root[1]:l}${${root[3,-1]}//\\//}"
  if (( $+commands[pwsh] )); then
    typeset -g __byndery_pwsh=$commands[pwsh]
  else
    typeset -g __byndery_pwsh=$root/System32/WindowsPowerShell/v1.0/powershell.exe
  fi
  typeset -g __byndery_cmdexe=$root/System32/cmd.exe
}

# MSYS2 rewrites arguments that look like POSIX paths (/c becomes C:/), which
# would break `cmd /c` and PowerShell syntax, so conversion is off for these.
__byndery_ps() {
  MSYS2_ARG_CONV_EXCL='*' $__byndery_pwsh -NoLogo -NoProfile -Command "$1"
}
__byndery_cmd() {
  MSYS2_ARG_CONV_EXCL='*' $__byndery_cmdexe /d /s /c "$1"
}

# C:\Users\me\x -> C:/Users/me/x for unquoted words; "\ " stays an escaped space.
__byndery_fix_paths() {
  setopt local_options extended_glob
  local -a words
  words=(${(z)1})
  local out=$1 w fixed
  integer at from=1
  for w in $words; do
    # Find this word by exact text from where the last one ended, then splice.
    at=${${out[from,-1]}[(ie)$w]}
    (( at > ${#out} - from + 1 )) && continue
    (( at += from - 1 ))
    from=$(( at + ${#w} ))
    [[ $w == [\'\"]* ]] && continue
    [[ $w == (*=|)[A-Za-z]:\\* ]] || continue
    fixed=${w//(#b)\\([^ ])//$match[1]}
    out="${out[1,at-1]}${fixed}${out[at+${#w},-1]}"
    (( from += ${#fixed} - ${#w} ))
  done
  REPLY=$out
}

__byndery_route_line() {
  setopt local_options extended_glob
  local typed=$BUFFER
  local -a words
  words=(${(z)BUFFER})
  local first=${words[1]}
  if [[ -n $first ]] && ! whence -- $first >/dev/null 2>&1; then
    if [[ $first == [A-Za-z]##-[A-Za-z]## || $first == '$env:'* || $first == '['[A-Za-z.]##']'* ]]; then
      BUFFER="__byndery_ps ${(q-)BUFFER}"
    elif (( $+__byndery_cmd_builtins[${first:l}] )); then
      if [[ ${first:l} == cls ]]; then BUFFER=clear
      else BUFFER="__byndery_cmd ${(q-)BUFFER}"; fi
    fi
  fi
  [[ $BUFFER == "$typed" && $BUFFER == *[A-Za-z]:\\* ]] && { __byndery_fix_paths $BUFFER; BUFFER=$REPLY }
  if [[ $BUFFER != "$typed" ]]; then
    __byndery_typed=$typed
    __byndery_ran=$BUFFER
  fi
  zle .accept-line
}
zle -N accept-line __byndery_route_line

# zle has already drawn the rewritten line; draw the typed one over it.
__byndery_redraw_typed() {
  [[ -n $__byndery_typed && $1 == "$__byndery_ran" ]] || return 0
  local typed=$__byndery_typed ran=$__byndery_ran
  __byndery_typed='' __byndery_ran=''
  # Only Powerlevel10k's prompt is known to end in a two-column "❯ ".
  (( $+functions[p10k] )) || return 0
  local cols=${COLUMNS:-80}
  local rows=$(( (2 + ${#ran} + cols - 1) / cols ))
  print -nr -- $'\e['${rows}$'A\r\e[J'
  print -rP -- "%(?.%F{2}.%F{1})❯%f ${typed//\%/%%}"
}
preexec_functions=(__byndery_redraw_typed ${preexec_functions:#__byndery_redraw_typed})

# History keeps the typed line too.
__byndery_history() {
  if [[ -n $__byndery_typed ]]; then
    print -sr -- $__byndery_typed
    return 1
  fi
}
autoload -Uz add-zsh-hook
add-zsh-hook zshaddhistory __byndery_history

# Run PowerShell scripts by name.
alias -s ps1="$__byndery_pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File"
