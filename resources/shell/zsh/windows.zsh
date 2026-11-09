# One prompt for Linux (zsh), PowerShell and cmd on Windows.
#
# When Enter is pressed, the line goes to one system, chosen in this order:
#
#  1. A prefix: `zsh: …`, `pwsh: …` or `cmd: …`. Prefixes work even for a
#     system that is switched off in Settings.
#  2. Syntax only PowerShell parses: an approved Verb-Noun first word
#     (Get-Process), `$env:`, `$name =`, or `[Type]::`.
#  3. zsh's own lookup (alias, function, builtin, program on PATH), except
#     `dir` and `cd /d`, which go to cmd while cmd is on.
#  4. cmd built-ins (copy, del, ren, md, rd, mklink, ver, ...).
#  5. zsh, which reports "command not found".
#
# A whole line goes to one system, so `Get-Process | Where-Object CPU -gt 9`
# keeps PowerShell's meaning; later stages of a pipeline are programs found
# on that system's PATH. `name.exe` always runs the Windows program. After a
# PowerShell or cmd line, its folder, exit code and environment changes come
# back to zsh, so `cd /d D:\x` and `$env:X = 1` stick.
#
# Unquoted Windows paths (C:\Users\me) are read as paths in zsh lines.
# The screen and history show the line as it was typed.
#
# Which systems take part is read on every Enter from $BYNDERY_ROUTING_FILE
# (written by Settings), using $(<file), which reads without a subprocess.

typeset -gA __byndery_cmd_builtins=(
  assoc 1 cls 1 color 1 copy 1 del 1 erase 1 ftype 1 md 1 mklink 1 move 1
  rd 1 ren 1 rename 1 title 1 ver 1 vol 1 pushd 0 popd 0
)
# Verbs from PowerShell's Get-Verb, plus the core *-Object cmdlets.
typeset -gA __byndery_ps_verbs
() {
  local v
  for v in Add Approve Assert Backup Block Build Checkpoint Clear Close Compare Complete \
    Compress Confirm Connect Convert ConvertFrom ConvertTo Copy Debug Deny Deploy Disable \
    Disconnect Dismount Edit Enable Enter Exit Expand Export Find Format Get Grant Group \
    Hide Import Initialize Install Invoke Join Limit Lock Measure Merge Mount Move New Open \
    Optimize Out Ping Pop Protect Publish Push Read Receive Redo Register Remove Rename \
    Repair Request Reset Resize Resolve Restart Restore Resume Revoke Save Search Select \
    Send Set Show Skip Split Start Step Stop Submit Suspend Switch Sync Test Trace Unblock \
    Undo Uninstall Unlock Unprotect Unpublish Unregister Update Use Wait Watch Write \
    ForEach Where Sort Tee
  do __byndery_ps_verbs[${v:l}]=1; done
}

typeset -g __byndery_typed='' __byndery_ran='' __byndery_tag=''

() {
  # Full paths: the inherited PATH can lack System32, and a direct exec skips
  # Cygwin's .exe lookup.
  local root=${SYSTEMROOT:-${SystemRoot:-C:\\Windows}}
  root="/${root[1]:l}${${root[3,-1]}//\\//}"
  if (( $+commands[pwsh] )); then
    typeset -g __byndery_pwsh=$commands[pwsh]
  else
    typeset -g __byndery_pwsh=$root/System32/WindowsPowerShell/v1.0/powershell.exe
  fi
  typeset -g __byndery_cmdexe=$root/System32/cmd.exe
  # Scratch files for handing state back from PowerShell and cmd, in both
  # path forms. One cygpath call at startup; none per line. The folder sits in
  # the user's temp, passed in by byndery, because the app folder may be
  # read-only once installed.
  typeset -g __byndery_tmp=${BYNDERY_TMP:-${TMPDIR:-/tmp}}/shell-$$
  mkdir -p $__byndery_tmp 2>/dev/null
  typeset -g __byndery_tmp_win=${$(cygpath -w $__byndery_tmp 2>/dev/null):-$__byndery_tmp}
  typeset -g __byndery_tmp_dos=${$(cygpath -d $__byndery_tmp 2>/dev/null):-$__byndery_tmp_win}
  # The console runs in UTF-8 from the start. Changing the code page later
  # makes ConPTY repaint the whole screen from its own copy, which wipes the
  # lines above; set once here, before the first prompt, it changes nothing.
  $root/System32/chcp.com 65001 >/dev/null 2>&1
}

# Windows path to MSYS form: C:\Users\me -> /c/Users/me.
__byndery_to_msys() {
  local p=${1%$'\r'}
  if [[ $p == [A-Za-z]:* ]]; then REPLY="/${p[1]:l}${${p[3,-1]}//\\//}"
  else REPLY=${p//\\//}; fi
}

# Variables a Windows shell reports in its own form, or that belong to zsh.
typeset -gA __byndery_env_skip=(
  PATH 1 Path 1 HOME 1 TEMP 1 TMP 1 PWD 1 OLDPWD 1 SHLVL 1 PROMPT 1 PS1 1 _ 1
  ORIGINAL_PATH 1 ORIGINAL_TEMP 1 ORIGINAL_TMP 1 MSYSTEM 1 TERM 1 SHELL 1
  PSModulePath 1 __BYNDERY_EL 1 ERRORLEVEL 1 CD 1 '=C:' 1 '=::' 1
)

# Reads what a PowerShell or cmd line left behind: exit code, folder, and the
# variables it set or removed. Returns the line's exit code.
__byndery_take_state() {
  setopt local_options extended_glob
  local file=$__byndery_tmp/state line code=0 cwd
  [[ -r $file ]] || return 1
  local -a lines
  lines=("${(@f)$(<$file)}")
  rm -f $file
  code=${lines[1]%$'\r'}
  cwd=${lines[2]%$'\r'}
  for line in ${lines[3,-1]}; do
    line=${line%$'\r'}
    if [[ $line == -* ]]; then
      (( $+__byndery_env_skip[${line#-}] )) || unset ${line#-} 2>/dev/null
    elif [[ $line == ?*=* ]]; then
      local k=${line%%=*} v=${line#*=}
      (( $+__byndery_env_skip[$k] )) && continue
      [[ $k == __BYNDERY_* ]] && continue
      [[ $k == [A-Za-z_][A-Za-z0-9_]# ]] || continue
      [[ ${(P)k} == "$v" ]] && continue
      export $k=$v
    fi
  done
  if [[ -n $cwd ]]; then
    __byndery_to_msys $cwd
    [[ $REPLY != $PWD ]] && builtin cd -q -- $REPLY 2>/dev/null
  fi
  [[ $code == <-> ]] || code=1
  return code
}

__byndery_ps() {
  local script=$__byndery_tmp/line.ps1
  local state="$__byndery_tmp_win\\state"
  local pre='$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8
Remove-Item alias:curl, alias:wget -ErrorAction SilentlyContinue
$__byndery_env = @{}
Get-ChildItem env: | ForEach-Object { $__byndery_env[$_.Name] = $_.Value }
$global:LASTEXITCODE = 0
$__byndery_ok = $true
try {
'
  local post='
  $__byndery_ok = $?
} catch {
  Write-Error $_
  $__byndery_ok = $false
} finally {
  $code = if ($LASTEXITCODE) { $LASTEXITCODE } elseif ($__byndery_ok) { 0 } else { 1 }
  $out = @("$code", (Get-Location).ProviderPath)
  Get-ChildItem env: | Where-Object { $__byndery_env[$_.Name] -ne $_.Value } | ForEach-Object { $out += "$($_.Name)=$($_.Value)" }
  $__byndery_env.Keys | Where-Object { -not (Test-Path "env:$_") } | ForEach-Object { $out += "-$_" }
  [IO.File]::WriteAllLines("@STATE@", [string[]]$out)
}'
  # PowerShell 5.1 reads a script without a BOM in the ANSI code page.
  print -rn -- $'\xef\xbb\xbf' >| $script
  print -r -- "$pre$1${post//@STATE@/$state}" >> $script
  MSYS2_ARG_CONV_EXCL='*' $__byndery_pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$__byndery_tmp_win\\line.ps1"
  # `exit 3` leaves the script early; then the process's own code is the answer.
  local proc=$?
  __byndery_take_state
  local took=$?
  return $(( proc ? proc : took ))
}

__byndery_cmd() {
  # The line runs from a small batch file. That keeps its quotes and
  # operators away from MSYS's argument quoting, expands %VAR% the way the
  # cmd prompt does, and reads %errorlevel% on the line after it. Batch files
  # need %%i in for loops where the prompt takes %i, so that is converted.
  setopt local_options extended_glob
  local line=$1 bat=$__byndery_tmp/line.cmd
  local state="$__byndery_tmp_win\\state" before="$__byndery_tmp_win\\before"
  [[ ${line:l} == for[[:space:]]* ]] && line=${line//(#b)%([A-Za-z])([^A-Za-z0-9_%]|(#e))/%%$match[1]$match[2]}
  local nl=$'\r\n'
  print -rn -- "@echo off${nl}chcp 65001>nul${nl}set>\"$before\"${nl}${line}${nl}@>\"$state\" echo %errorlevel%${nl}@>>\"$state\" cd${nl}@>>\"$state\" set${nl}" >| $bat
  MSYS2_ARG_CONV_EXCL='*' $__byndery_cmdexe /d /c ${__byndery_tmp_dos}\\line.cmd
  local fallback=$?
  [[ -r $__byndery_tmp/state ]] || { rm -f $__byndery_tmp/before; return fallback }
  # cmd reports every variable; keep only the ones the line changed.
  local -A was
  local entry
  for entry in "${(@f)$(<$__byndery_tmp/before)}"; do was[${entry%%=*}]=${${entry#*=}%$'\r'}; done
  local -a now kept
  now=("${(@f)$(<$__byndery_tmp/state)}")
  kept=(${now[1,2]})
  for entry in ${now[3,-1]}; do
    entry=${entry%$'\r'}
    [[ ${was[${entry%%=*}]-__byndery_unset} == "${entry#*=}" ]] || kept+=$entry
  done
  print -rl -- $kept >| $__byndery_tmp/state
  rm -f $__byndery_tmp/before
  __byndery_take_state
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

# Decides which system runs a line. Sets REPLY to zsh, pwsh or cmd, and
# __byndery_line to the line without any prefix.
__byndery_pick() {
  setopt local_options extended_glob
  local line=$1 linux=1 pwsh=1 cmd=1
  if [[ -n $BYNDERY_ROUTING_FILE && -r $BYNDERY_ROUTING_FILE ]]; then
    local cfg=$(<$BYNDERY_ROUTING_FILE)
    [[ $cfg == *linux=0* ]] && linux=0
    [[ $cfg == *powershell=0* ]] && pwsh=0
    [[ $cfg == *cmd=0* ]] && cmd=0
  fi
  __byndery_line=$line
  case $line in
    (zsh:*) __byndery_line=${line#zsh:}; __byndery_line=${__byndery_line# }; REPLY=zsh; return ;;
    (pwsh:*) __byndery_line=${line#pwsh:}; __byndery_line=${__byndery_line# }; REPLY=pwsh; return ;;
    (cmd:*) __byndery_line=${line#cmd:}; __byndery_line=${__byndery_line# }; REPLY=cmd; return ;;
  esac
  local -a words
  words=(${(z)line})
  local first=${words[1]} low=${words[1]:l}
  REPLY=zsh
  [[ -z $first ]] && return
  # Leaving the shell always means zsh.
  [[ $low == (exit|logout|clear) ]] && return

  if (( pwsh )); then
    if [[ $first == (#b)([A-Za-z]##)-[A-Za-z]## ]] && (( $+__byndery_ps_verbs[${match[1]:l}] )) && ! whence -- $first >/dev/null 2>&1; then
      REPLY=pwsh; return
    fi
    if [[ $first == '$env:'* || $line == '$'[A-Za-z_][A-Za-z0-9_:]#' '#'='[^=]* || $first == '['[A-Za-z.]##']::'* ]]; then
      REPLY=pwsh; return
    fi
  fi
  if (( cmd )); then
    [[ $low == dir ]] && { REPLY=cmd; return }
    [[ $low == cd && ${words[2]:l} == /d ]] && { REPLY=cmd; return }
  fi
  if (( linux )) && whence -- $first >/dev/null 2>&1; then
    return
  fi
  if (( cmd )) && (( ${__byndery_cmd_builtins[$low]:-0} )); then
    REPLY=cmd; return
  fi
  # With Linux off, plain lines go to PowerShell, or to cmd.
  if (( ! linux )); then
    if (( pwsh )); then REPLY=pwsh; elif (( cmd )); then REPLY=cmd; fi
  fi
}

__byndery_route_line() {
  setopt local_options extended_glob
  local typed=$BUFFER
  __byndery_tag=''
  __byndery_pick $BUFFER
  case $REPLY in
    (pwsh)
      BUFFER="__byndery_ps ${(q-)__byndery_line}"
      __byndery_tag=PS ;;
    (cmd)
      if [[ ${__byndery_line:l} == cls ]]; then BUFFER=clear
      else BUFFER="__byndery_cmd ${(q-)__byndery_line}"; __byndery_tag=cmd; fi ;;
    (*)
      BUFFER=$__byndery_line
      [[ $BUFFER == *[A-Za-z]:\\* ]] && { __byndery_fix_paths $BUFFER; BUFFER=$REPLY } ;;
  esac
  if [[ $BUFFER != "$typed" ]]; then
    __byndery_typed=$typed
    __byndery_ran=$BUFFER
  fi
  zle .accept-line
}
zle -N accept-line __byndery_route_line

# zle has already drawn the rewritten line; draw the typed one over it, with
# PS or cmd in front when another system runs it.
__byndery_redraw_typed() {
  local last=$?
  [[ -n $__byndery_typed && $1 == "$__byndery_ran" ]] || return 0
  local typed=$__byndery_typed ran=$__byndery_ran tag=$__byndery_tag
  __byndery_typed='' __byndery_ran=''
  # The command memory records the line as typed, not the routed form.
  typeset -g __byndery_display=$typed
  # Only Powerlevel10k's prompt is known to end in a two-column "❯ ".
  (( $+functions[p10k] )) || return 0
  # A typed prefix already says which system runs the line.
  [[ $typed == (zsh|pwsh|cmd):* ]] && tag=''
  local cols=${COLUMNS:-80}
  local rows=$(( (2 + ${#ran} + cols - 1) / cols ))
  # Raw colour codes, not print -P: with prompt_subst on, -P would expand a
  # typed $env:X as a zsh variable.
  local mark=$'\e[32m'
  (( last )) && mark=$'\e[31m'
  print -nr -- $'\e['${rows}$'A\r\e[J'"${mark}❯"$'\e[0m '
  [[ -n $tag ]] && print -nr -- $'\e[90m'"$tag"$'\e[0m '
  print -r -- "$typed"
}
preexec_functions=(__byndery_redraw_typed ${preexec_functions:#__byndery_redraw_typed})

# History keeps the typed line.
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
