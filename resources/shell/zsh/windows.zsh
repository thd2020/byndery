# One prompt for Linux (zsh), PowerShell and cmd on Windows.
#
# When Enter is pressed, the whole line goes to one system. The choice works
# like a shell's own command lookup, with the order set in Settings:
#
#  1. A prefix (`zsh:`, `pwsh:`, `cmd:` by default) picks the system
#     outright, even one that is switched off.
#  2. A name the user pinned in Settings (`dir` to cmd by default) goes to
#     its system.
#  3. Syntax only PowerShell parses goes to PowerShell: `$env:`, `$x = 1`,
#     `[Type]::`, or an approved Verb-Noun cmdlet zsh does not know.
#     `cd /d` goes to cmd.
#  4. Otherwise the systems are asked in order, and the first that knows the
#     first word runs the line: zsh by its own lookup (alias, function,
#     builtin, program on PATH), cmd by its built-in commands, PowerShell by
#     Verb-Noun.
#  5. Nothing knows it: the first system in the order reports the error.
#
# `byndery-route <line>` prints the choice and the rule behind it, the way
# `type -a` explains a name. Later stages of a pipeline are programs on that
# system's PATH, and `name.exe` always runs the Windows program. After a
# PowerShell or cmd line, its folder, exit code and environment changes come
# back to zsh, so `cd /d D:\x` and `$env:X = 1` stick.
#
# Unquoted Windows paths (C:\Users\me) are read as paths in zsh lines.
# The screen and history show the line as it was typed.
#
# The settings come from $BYNDERY_ROUTING_FILE, written by byndery and read
# on every Enter with $(<file), which needs no subprocess.

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

# Settings runs `zsh -f` to explain a line; that zsh has no login PATH.
[[ -n $BYNDERY_EXPLAIN ]] && path=(/ucrt64/bin /usr/local/bin /usr/bin $path)

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
  typeset -g __byndery_tmp=${BYNDERY_TMP:-${TMPDIR:-/tmp}}/shell-$
  [[ -n $BYNDERY_EXPLAIN ]] && return
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

# Routing settings, parsed again only when the file's text changes.
typeset -g __byndery_cfg_text=$'\0'
typeset -ga __byndery_order __byndery_on
typeset -gA __byndery_prefix __byndery_override
typeset -gi __byndery_pssyntax=1
__byndery_read_config() {
  setopt local_options extended_glob
  local text=''
  [[ -n $BYNDERY_ROUTING_FILE && -r $BYNDERY_ROUTING_FILE ]] && text=$(<$BYNDERY_ROUTING_FILE)
  [[ $text == "$__byndery_cfg_text" ]] && return
  __byndery_cfg_text=$text
  __byndery_order=(linux powershell cmd) __byndery_on=(linux powershell cmd)
  __byndery_prefix=(linux zsh: powershell pwsh: cmd cmd:) __byndery_override=(dir cmd)
  __byndery_pssyntax=1
  [[ -z $text ]] && return
  __byndery_override=()
  local line k v
  for line in ${(f)text}; do
    line=${line%$'\r'}
    k=${line%%=*} v=${line#*=}
    case $k in
      (order) __byndery_order=(${=v}) ;;
      (on) __byndery_on=(${=v}) ;;
      (pssyntax) __byndery_pssyntax=${v:-0} ;;
      (prefix.*) __byndery_prefix[${k#prefix.}]=$v ;;
      (override.*) __byndery_override[${k#override.}]=$v ;;
    esac
  done
}

# Whether a system knows the first word of a line.
__byndery_knows() {
  setopt local_options extended_glob
  local sys=$1 first=$2
  case $sys in
    (linux) whence -- $first >/dev/null 2>&1 ;;
    (cmd) (( ${__byndery_cmd_builtins[${first:l}]:-0} )) ;;
    (powershell) [[ $first == (#b)([A-Za-z]##)-[A-Za-z]## ]] && (( $+__byndery_ps_verbs[${match[1]:l}] )) ;;
    (*) return 1 ;;
  esac
}

typeset -gA __byndery_tag_of=(linux zsh powershell pwsh cmd cmd)

# Decides which system runs a line. Sets REPLY to zsh, pwsh or cmd,
# __byndery_line to the line without any prefix, and __byndery_why to the
# rule that decided.
__byndery_pick() {
  setopt local_options extended_glob
  __byndery_read_config
  local line=$1 sys pre
  __byndery_line=$line
  for sys in linux powershell cmd; do
    pre=${__byndery_prefix[$sys]}
    [[ -n $pre && $line == "$pre"* ]] || continue
    __byndery_line=${line#$pre}; __byndery_line=${__byndery_line# }
    REPLY=${__byndery_tag_of[$sys]} __byndery_why="prefix $pre"
    return
  done
  local -a words
  words=(${(z)line})
  local first=${words[1]} low=${words[1]:l}
  REPLY=zsh __byndery_why='empty line'
  [[ -z $first ]] && return
  # Leaving or clearing the shell always means zsh.
  [[ $low == (exit|logout|clear) ]] && { __byndery_why='zsh itself'; return }
  local on=" ${__byndery_on} "
  sys=${__byndery_override[$low]}
  if [[ -n $sys && $on == *" $sys "* ]]; then
    REPLY=${__byndery_tag_of[$sys]} __byndery_why="pinned in Settings"
    return
  fi
  if (( __byndery_pssyntax )) && [[ $on == *' powershell '* ]]; then
    if [[ $first == '$env:'* || $line == '$'[A-Za-z_][A-Za-z0-9_:]#' '#'='[^=]* || $first == '['[A-Za-z.]##']::'* ]]; then
      REPLY=pwsh __byndery_why='PowerShell syntax'; return
    fi
    if __byndery_knows powershell $first && ! whence -- $first >/dev/null 2>&1; then
      REPLY=pwsh __byndery_why='PowerShell cmdlet'; return
    fi
  fi
  if [[ $on == *' cmd '* && $low == cd && ${words[2]:l} == /d ]]; then
    REPLY=cmd __byndery_why='cmd syntax (cd /d)'; return
  fi
  for sys in $__byndery_order; do
    [[ $on == *" $sys "* ]] || continue
    if __byndery_knows $sys $first; then
      REPLY=${__byndery_tag_of[$sys]}
      case $sys in
        (linux)
          # whence -w prints "name: kind".
          local kind
          kind=$(whence -w -- $first 2>/dev/null)
          kind=${kind##*:}
          case ${kind## #} in
            (alias) __byndery_why='zsh alias' ;;
            (function) __byndery_why='zsh function' ;;
            (builtin) __byndery_why='zsh builtin' ;;
            (reserved) __byndery_why='zsh keyword' ;;
            (*) __byndery_why="program ${$(whence -p -- $first 2>/dev/null):-$first}" ;;
          esac ;;
        (cmd) __byndery_why='cmd built-in' ;;
        (powershell) __byndery_why='PowerShell cmdlet' ;;
      esac
      return
    fi
  done
  # Nothing knows it: the first system on reports "not found".
  sys=${${=__byndery_on}[1]:-linux}
  REPLY=${__byndery_tag_of[$sys]} __byndery_why='not found anywhere'
}

# For Settings and for byndery-route: system and rule, tab-separated.
__byndery_explain() {
  local __byndery_why
  __byndery_pick "$1"
  print -r -- "$REPLY"$'\t'"$__byndery_why"
}

byndery-route() {
  local __byndery_why
  __byndery_pick "$*"
  local -A names=(zsh Linux pwsh PowerShell cmd 'Command Prompt')
  print -r -- "${names[$REPLY]} ($__byndery_why)"
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

# Display width of the prompt's last line, where the command line starts.
# Works for any prompt: it is expanded the way zle drew it, then stripped of
# escape sequences.
__byndery_prompt_width() {
  setopt local_options extended_glob
  local p=${(%%)PS1}
  p=${p//$'\e'\][^$'\a']#$'\a'/}
  p=${p//$'\e'\[[0-9;?]#[A-Za-z]/}
  p=${p##*$'\n'}
  REPLY=${(m)#p}
}

# zle has already drawn the rewritten line; draw the typed one over it, with
# PS or cmd in front when another system runs it. The prompt stays as drawn.
__byndery_redraw_typed() {
  [[ -n $__byndery_typed && $1 == "$__byndery_ran" ]] || return 0
  local typed=$__byndery_typed ran=$__byndery_ran tag=$__byndery_tag
  __byndery_typed='' __byndery_ran=''
  # The command memory records the line as typed, not the routed form.
  typeset -g __byndery_display=$typed
  # A typed prefix already says which system runs the line.
  [[ $typed == (zsh|pwsh|cmd):* ]] && tag=''
  __byndery_prompt_width
  local width=$REPLY cols=${COLUMNS:-80}
  local rows=$(( (width + ${(m)#ran} + cols - 1) / cols ))
  (( rows < 1 )) && rows=1
  # Up to where the line began, past the prompt, then clear what follows.
  # Raw codes, not print -P: with prompt_subst on, -P would expand a typed
  # $env:X as a zsh variable.
  print -nr -- $'\e['${rows}$'A\r'
  (( width )) && print -nr -- $'\e['${width}'C'
  print -nr -- $'\e[J'
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
