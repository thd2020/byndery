# Defaults for someone without a .zshrc, so a first zsh session is
# comfortable instead of bare. A .zshrc of their own replaces all of this.

HISTFILE=${HISTFILE:-$HOME/.zsh_history}
HISTSIZE=50000
SAVEHIST=50000
setopt extended_history share_history hist_ignore_dups hist_ignore_space hist_reduce_blanks
setopt auto_cd auto_pushd pushd_ignore_dups interactive_comments no_beep

bindkey -e
bindkey '^[[H' beginning-of-line '^[[F' end-of-line '^[[3~' delete-char
bindkey '^[[1;5C' forward-word '^[[1;5D' backward-word '^H' backward-kill-word
autoload -Uz up-line-or-beginning-search down-line-or-beginning-search
zle -N up-line-or-beginning-search
zle -N down-line-or-beginning-search
bindkey '^[[A' up-line-or-beginning-search '^[[B' down-line-or-beginning-search

# Completion, case-insensitive because Windows file names are. The bundled
# zsh-completions definitions join fpath before compinit reads it.
[[ -d $BYNDERY_ZSH_PLUGINS/zsh-completions/src ]] && fpath=($BYNDERY_ZSH_PLUGINS/zsh-completions/src $fpath)
autoload -Uz compinit
() {
  local dump=${XDG_CACHE_HOME:-$HOME/.cache}/zsh/zcompdump-$ZSH_VERSION
  [[ -d ${dump:h} ]] || mkdir -p ${dump:h}
  compinit -C -d $dump
}
zstyle ':completion:*' matcher-list 'm:{a-zA-Z}={A-Za-z}' 'r:|[._-]=* r:|=*'
zstyle ':completion:*' menu select
zstyle ':completion:*' list-colors ${(s.:.)LS_COLORS}

alias ls='ls --color=auto'
alias ll='ls -lAh'
alias grep='grep --color=auto'
