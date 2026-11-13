# The zsh plugins byndery ships: suggestions from history as you type, syntax
# colours, extra completions, history search on the arrow keys, and Oh My
# Zsh's git aliases. Each one is skipped when the user's own config already
# loaded it (or a plugin that does the same job).
#
# Load order matters: zsh-completions must be on fpath before compinit (see
# defaults.zsh), and syntax highlighting goes last so it wraps every widget,
# byndery's line router included.

[[ -n $BYNDERY_ZSH_PLUGINS && -d $BYNDERY_ZSH_PLUGINS ]] || return 0
() {
  local dir=$BYNDERY_ZSH_PLUGINS
  # Settings > Shell can switch each one off (BYNDERY_PLUGINS_OFF, from the managed file).
  local -a off=(${=BYNDERY_PLUGINS_OFF})

  if (( ! $+functions[_zsh_autosuggest_start] && ! ${off[(Ie)autosuggestions]} )); then
    # History only: the completion strategy runs a hidden shell per key,
    # and starting processes is slow under MSYS2.
    ZSH_AUTOSUGGEST_STRATEGY=(history)
    ZSH_AUTOSUGGEST_BUFFER_MAX_SIZE=200
    ZSH_AUTOSUGGEST_MANUAL_REBIND=1
    source $dir/zsh-autosuggestions/zsh-autosuggestions.zsh
    # Async mode starts a process for every key. That is cheap on Linux and
    # macOS but costs about 20 ms a key under MSYS2, where the synchronous
    # history search takes well under one.
    [[ $OSTYPE == (msys|cygwin)* ]] && unset ZSH_AUTOSUGGEST_USE_ASYNC
  fi

  if (( ! $+functions[history-substring-search-up] && ! ${off[(Ie)history-substring-search]} )); then
    source $dir/zsh-history-substring-search/zsh-history-substring-search.zsh
    bindkey '^[[A' history-substring-search-up '^[OA' history-substring-search-up
    bindkey '^[[B' history-substring-search-down '^[OB' history-substring-search-down
  fi

  # Oh My Zsh users already have these aliases; everyone else gets them.
  if [[ -z $ZSH ]] && (( ! $+functions[git_current_branch] && ! ${off[(Ie)git-aliases]} )); then
    source $dir/ohmyzsh-git/git-lib.zsh
    source $dir/ohmyzsh-git/git.plugin.zsh
  fi

  if (( ! $+ZSH_HIGHLIGHT_VERSION && ! $+FAST_HIGHLIGHT && ! ${off[(Ie)syntax-highlighting]} )); then
    ZSH_HIGHLIGHT_HIGHLIGHTERS=(main brackets)
    source $dir/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh
  fi
}
