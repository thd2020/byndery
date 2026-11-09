# Runs the user's .zshrc, or sensible defaults when there is none, then adds
# byndery's prompt theme, shell integration and, on Windows, the command router.

__byndery_prompt_before=$PROMPT

if [[ -r $BYNDERY_USER_ZDOTDIR/.zshrc ]]; then
  ZDOTDIR=$BYNDERY_USER_ZDOTDIR
  source $BYNDERY_USER_ZDOTDIR/.zshrc
  __byndery_user_zshrc=1
else
  source $BYNDERY_ZDOTDIR/defaults.zsh
fi

# From here on zsh uses the user's folder, so it reads their .zlogin itself.
ZDOTDIR=$BYNDERY_USER_ZDOTDIR

# Powerlevel10k is the default prompt. It is left out when the user chose
# their own prompt: a framework theme, Starship, Oh My Posh, or a PROMPT that
# their .zshrc changed. BYNDERY_PROMPT=keep or =p10k overrides the check.
() {
  [[ -n $BYNDERY_P10K && -r $BYNDERY_P10K/powerlevel10k.zsh-theme ]] || return
  case ${BYNDERY_PROMPT:-auto} in
    keep|off|0) return ;;
    p10k|on|1) ;;
    *)
      (( $+functions[p10k] )) && return
      (( $+functions[starship_precmd] || $+functions[_omp_precmd] )) && return
      [[ -n $ZSH_THEME && $ZSH_THEME != robbyrussell ]] && return
      [[ -n $__byndery_user_zshrc && $PROMPT != $__byndery_prompt_before ]] && return
      ;;
  esac
  source $BYNDERY_P10K/powerlevel10k.zsh-theme
  if [[ -r $BYNDERY_USER_ZDOTDIR/.p10k.zsh ]]; then
    source $BYNDERY_USER_ZDOTDIR/.p10k.zsh
  else
    source $BYNDERY_ZDOTDIR/p10k.zsh
  fi
}
unset __byndery_prompt_before __byndery_user_zshrc

source $BYNDERY_ZDOTDIR/integration.zsh
[[ $OSTYPE == (msys|cygwin)* ]] && source $BYNDERY_ZDOTDIR/windows.zsh
source $BYNDERY_ZDOTDIR/plugins.zsh
