# byndery shell integration for bash (Git Bash on Windows, bash elsewhere).
# Loaded with `bash --init-file <this> -i`. It replays the startup files bash
# would have read as a login shell, then reports prompts, commands and the
# working directory with OSC 133 and OSC 7 so the app can mark commands and
# keep the file tree in step with the shell. prompt.sh beside it supplies the
# default prompt theme.

if [ -n "$BYNDERY_SHELL_LOGIN" ]; then
  unset BYNDERY_SHELL_LOGIN
  [ -r /etc/profile ] && . /etc/profile
  if [ -r ~/.bash_profile ]; then . ~/.bash_profile
  elif [ -r ~/.bash_login ]; then . ~/.bash_login
  elif [ -r ~/.profile ]; then . ~/.profile
  fi
else
  [ -r ~/.bashrc ] && . ~/.bashrc
fi

if [ -z "$__byndery_loaded" ]; then
  __byndery_loaded=1
  __byndery_in_command=0
  __byndery_in_prompt=0

  # Literal escapes rather than $(...) inside PS1: under MSYS every fork
  # costs tens of milliseconds, and a prompt should not pay for two.
  __byndery_ps1_a=$'\\[\e]133;A\a\\]'
  __byndery_ps1_b=$'\\[\e]133;B\a\\]'

  __byndery_precmd() {
    local status=$?
    __byndery_in_prompt=1
    if [ "$__byndery_in_command" = 1 ]; then
      printf '\e]133;D;%s\a' "$status"
      __byndery_in_command=0
      __byndery_last_status=$status
      if [ -n "$__byndery_t0" ] && [ -n "$EPOCHREALTIME" ]; then
        local t1=$EPOCHREALTIME
        __byndery_last_duration=$(( (10#${t1//[.,]/} - 10#${__byndery_t0//[.,]/}) / 1000 ))
      fi
    else
      # An empty Enter clears the previous command's status and time.
      __byndery_last_status=0
      __byndery_last_duration=
    fi
    # Git Bash reports $PWD as /c/Users/me or, when started in a Windows
    # folder, as C:/Users/me; either way the URL needs a slash before it.
    case "$PWD" in
      /*) printf '\e]7;file://%s%s\a' "${HOSTNAME:-localhost}" "$PWD" ;;
      *) printf '\e]7;file://%s/%s\a' "${HOSTNAME:-localhost}" "$PWD" ;;
    esac
    return $status
  }

  # Runs last in PROMPT_COMMAND, so a user hook that rebuilds PS1 keeps the marks.
  __byndery_wrap_ps1() {
    __byndery_in_prompt=0
    case "$PS1" in
      *'133;A'*) ;;
      *) PS1="${__byndery_ps1_a}${PS1}${__byndery_ps1_b}" ;;
    esac
  }

  # The DEBUG trap fires before every simple command, including the ones in
  # PROMPT_COMMAND and completion functions, so only the first command of a
  # line the user submitted counts as the start of output.
  __byndery_preexec() {
    [ -n "$COMP_LINE" ] && return
    [ "$__byndery_in_command" = 1 ] && return
    [ "$__byndery_in_prompt" = 1 ] && return
    case "$BASH_COMMAND" in __byndery_*) return ;; esac
    __byndery_in_command=1
    __byndery_t0=$EPOCHREALTIME
    printf '\e]133;C\a'
  }

  [ -r "${BASH_SOURCE[0]%/*}/prompt.sh" ] && . "${BASH_SOURCE[0]%/*}/prompt.sh"
  __byndery_tail=__byndery_wrap_ps1
  [ -n "$__byndery_theme_on" ] && __byndery_tail="__byndery_theme; __byndery_wrap_ps1"

  if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
    PROMPT_COMMAND=(__byndery_precmd "${PROMPT_COMMAND[@]}" "$__byndery_tail")
  else
    PROMPT_COMMAND="__byndery_precmd${PROMPT_COMMAND:+; $PROMPT_COMMAND}; $__byndery_tail"
  fi
  [ -n "$__byndery_theme_on" ] && __byndery_theme
  __byndery_wrap_ps1
  trap '__byndery_preexec' DEBUG
fi

# The file tree sends " cd <folder>" with a leading space when it syncs with
# the terminal; this keeps those lines out of the history.
case ":$HISTCONTROL:" in *:ignorespace:*|*:ignoreboth:*) ;; *) HISTCONTROL="ignorespace${HISTCONTROL:+:$HISTCONTROL}" ;; esac
