# OSC 133 command marks and OSC 7 working directory for zsh.
#
# The marks are printed from hooks rather than spliced into PROMPT, because
# Powerlevel10k and other themes rebuild PROMPT on every redraw. The status
# hook goes first so it sees the command's exit code; the prompt-start hook
# goes last so it fires right before the prompt is drawn.

autoload -Uz add-zsh-hook

typeset -gi __byndery_running=0

__byndery_status() {
  local code=$?
  if (( __byndery_running )); then
    print -n "\e]133;D;${code}\a"
    __byndery_running=0
  fi
  if [[ $PWD == /* ]]; then
    print -n "\e]7;file://${HOST}${PWD}\a"
  else
    print -n "\e]7;file://${HOST}/${PWD}\a"
  fi
  return code
}

__byndery_prompt_start() {
  print -n "\e]133;A\a"
}

# OSC 633;E carries the command line itself, escaped the way VS Code does:
# backslash doubled, semicolon and control characters as \xNN. byndery keeps
# it in its command memory. A line the router sent to PowerShell or cmd is
# reported as it was typed ($__byndery_display, set by windows.zsh).
__byndery_preexec() {
  setopt local_options extended_glob
  __byndery_running=1
  local line=${__byndery_display:-$1}
  __byndery_display=''
  line=${line//\\/\\\\}
  line=${line//;/\\x3b}
  # Every control character as \xNN, computed in place without a subprocess.
  line=${line//(#m)[[:cntrl:]]/\\x${(l:2::0:)$(( [##16] #MATCH ))}}
  print -rn -- $'\e]633;E;'"$line"$'\a'
  print -n "\e]133;C\a"
}

precmd_functions=(__byndery_status ${precmd_functions:#__byndery_*} __byndery_prompt_start)
add-zsh-hook preexec __byndery_preexec
