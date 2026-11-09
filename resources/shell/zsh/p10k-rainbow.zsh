# byndery's default prompt: Powerlevel10k's own rainbow style, the one
# `p10k configure` writes for Rainbow, Unicode, two lines, a full frame,
# sharp heads and tails, and many icons. It needs a Nerd Font; byndery's
# terminal uses the bundled MesloLGS NF. A ~/.p10k.zsh of your own is used
# instead of this file.
#
# The template ships with Powerlevel10k; this file only changes what
# differs from it.

source ${BYNDERY_P10K}/config/p10k-rainbow.zsh

'builtin' 'local' '-a' 'p10k_config_opts'
[[ ! -o 'aliases'         ]] || p10k_config_opts+=('aliases')
[[ ! -o 'sh_glob'         ]] || p10k_config_opts+=('sh_glob')
[[ ! -o 'no_brace_expand' ]] || p10k_config_opts+=('no_brace_expand')
'builtin' 'setopt' 'no_aliases' 'no_sh_glob' 'brace_expand'

() {
  emulate -L zsh -o extended_glob

  # MesloLGS NF carries the Nerd Fonts v3 code points, which is what the
  # wizard picks when it can draw them.
  typeset -g POWERLEVEL9K_MODE=nerdfont-v3
  typeset -g POWERLEVEL9K_LEFT_PROMPT_ELEMENTS=(os_icon dir vcs newline)

  # The template paints segments with the eight theme colours, which a light
  # theme darkens for text; black on a darkened yellow is unreadable. Fixed
  # 256-colour equivalents keep the prompt the same on any background.
  local -A bg=(0 236 1 160 2 70 3 178 4 31 5 133 6 37 7 252)
  local -A fg=(0 16 1 196 2 70 3 178 4 33 5 170 6 37 7 255)
  local v
  for v in ${(M)${(k)parameters}:#POWERLEVEL9K_*_BACKGROUND}; do
    [[ ${(P)v} == <0-7> ]] && typeset -g $v=${bg[${(P)v}]}
  done
  for v in ${(M)${(k)parameters}:#POWERLEVEL9K_*_FOREGROUND}; do
    [[ ${(P)v} == <0-7> ]] && typeset -g $v=${fg[${(P)v}]}
  done

  # The first prompt draws before gitstatus has answered; show nothing for
  # git until it has, instead of "loading" and a bare "@".
  typeset -g POWERLEVEL9K_VCS_LOADING_TEXT=
  if (( $+functions[my_git_formatter] )); then
    functions[__byndery_template_git_formatter]=$functions[my_git_formatter]
    function my_git_formatter() {
      emulate -L zsh
      if [[ -z $P9K_CONTENT && -z $VCS_STATUS_LOCAL_BRANCH$VCS_STATUS_TAG$VCS_STATUS_COMMIT ]]; then
        typeset -g my_git_format=''
        return
      fi
      __byndery_template_git_formatter "$@"
    }
    functions -M my_git_formatter 2>/dev/null
  fi
  typeset -g POWERLEVEL9K_VCS_DISABLED_WORKDIR_PATTERN='~'

  # byndery prints its own OSC 133 marks, and the prompt is drawn fresh
  # every time; the template's instant prompt and wizard stay off.
  typeset -g POWERLEVEL9K_TERM_SHELL_INTEGRATION=false
  typeset -g POWERLEVEL9K_TRANSIENT_PROMPT=off
  typeset -g POWERLEVEL9K_INSTANT_PROMPT=off
  typeset -g POWERLEVEL9K_DISABLE_HOT_RELOAD=true
  typeset -g POWERLEVEL9K_DISABLE_CONFIGURATION_WIZARD=true

  (( ! $+functions[p10k] )) || p10k reload
}

(( ${#p10k_config_opts} )) && setopt ${p10k_config_opts[@]}
'builtin' 'unset' 'p10k_config_opts'
