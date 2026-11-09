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

__byndery_preexec() {
  __byndery_running=1
  print -n "\e]133;C\a"
}

precmd_functions=(__byndery_status ${precmd_functions:#__byndery_*} __byndery_prompt_start)
add-zsh-hook preexec __byndery_preexec
