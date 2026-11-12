# byndery prompt theme for bash, in the style of Powerlevel10k's "lean" preset.
#
#   ~/projects/byndery  main ⇡1 +2 !1 ?3                exit 1  4.2s  14:02:11
#   ❯
#
# Everything is built with bash builtins. The one subprocess per prompt is
# `git status` inside a repository, and a repository where that takes longer
# than half a second falls back to the branch name alone, which is the same
# trade-off Powerlevel10k makes for large repositories.
#
# It replaces only a stock prompt (Git for Windows, MSYS2, or a distribution
# default). A custom PS1, Starship or Oh My Posh is left alone. Set
# BYNDERY_PROMPT=keep to always keep your own prompt, or BYNDERY_PROMPT=byndery
# to always use this one. BYNDERY_PROMPT_GIT=0 turns off the file counts.

__byndery_prompt_wanted() {
  case "${BYNDERY_PROMPT:-auto}" in
    keep|off|0) return 1 ;;
    byndery|on|1) return 0 ;;
  esac
  case "${PROMPT_COMMAND[*]}" in *starship*|*_omp_*|*__vsc_*|*_p9k*) return 1 ;; esac
  case "$PS1" in
    *TITLEPREFIX*|*'$MSYSTEM'*|*debian_chroot*|'\s-\v\$ '|'[\u@\h \W]\$ '|'\h:\W \u\$ '|'') return 0 ;;
  esac
  return 1
}

if __byndery_prompt_wanted; then
  case "${LC_ALL:-${LC_CTYPE:-$LANG}}" in
    *[Uu][Tt][Ff]-8*|*[Uu][Tt][Ff]8*) __bp_char='❯' __bp_up='⇡' __bp_down='⇣' ;;
    *) __bp_char='>' __bp_up='^' __bp_down='v' ;;
  esac
  declare -A __bp_slow_repo=()

  # Colours are plain ANSI indexes so they follow the terminal's theme.
  # Each colour comes twice: wrapped in \[ \] for the left side, and bare for
  # the right side, which already sits inside one \[ \] and cannot nest another.
  __bp_c() { printf -v "$1" '\\[\\e[%sm\\]' "$2"; printf -v "$1_raw" '\\e[%sm' "$2"; }
  __bp_c __bp_dir '1;34'
  __bp_c __bp_green '32'
  __bp_c __bp_yellow '33'
  __bp_c __bp_red '31'
  __bp_c __bp_cyan '36'
  __bp_c __bp_dim '90'
  __bp_c __bp_reset '0'

  # Finds the enclosing repository without running git: walks up looking for
  # .git, follows a worktree's "gitdir:" file, and reads HEAD.
  __bp_git_head() {
    local d=$PWD gitdir line
    __bp_repo='' __bp_branch=''
    while :; do
      if [ -d "$d/.git" ]; then gitdir="$d/.git"; break; fi
      if [ -f "$d/.git" ]; then
        IFS= read -r line < "$d/.git"
        gitdir=${line#gitdir: }
        case "$gitdir" in /*|[A-Za-z]:*) ;; *) gitdir="$d/$gitdir" ;; esac
        break
      fi
      [ -z "$d" ] || [ "$d" = / ] && return 1
      line=${d%/*}
      [ "$line" = "$d" ] && return 1
      d=$line
    done
    __bp_repo=$d
    [ -r "$gitdir/HEAD" ] || return 0
    IFS= read -r line < "$gitdir/HEAD"
    case "$line" in
      'ref: refs/heads/'*) __bp_branch=${line#ref: refs/heads/} ;;
      *) __bp_branch="@${line:0:8}" ;;
    esac
  }

  __bp_git_counts() {
    __bp_counts=''
    [ "${BYNDERY_PROMPT_GIT:-1}" = 0 ] && return
    [ -n "${__bp_slow_repo[$__bp_repo]}" ] && return
    local t0=$EPOCHREALTIME out line ahead=0 behind=0 staged=0 changed=0 untracked=0 conflicts=0
    out=$(git --no-optional-locks status --porcelain=v2 --branch --untracked-files=normal 2>/dev/null) || return
    if [ -n "$t0" ]; then
      local t1=$EPOCHREALTIME
      local us=$(( 10#${t1//[.,]/} - 10#${t0//[.,]/} ))
      (( us > 500000 )) && __bp_slow_repo[$__bp_repo]=1
    fi
    while IFS= read -r line; do
      case "$line" in
        '# branch.ab '*)
          line=${line#\# branch.ab +}
          ahead=${line%% *}
          behind=${line##*-}
          ;;
        '1 '*|'2 '*)
          [ "${line:2:1}" != . ] && staged=$((staged + 1))
          [ "${line:3:1}" != . ] && changed=$((changed + 1))
          ;;
        'u '*) conflicts=$((conflicts + 1)) ;;
        '? '*) untracked=$((untracked + 1)) ;;
      esac
    done <<< "$out"
    (( behind )) && __bp_counts+=" ${__bp_green}${__bp_down}${behind}"
    (( ahead )) && __bp_counts+=" ${__bp_green}${__bp_up}${ahead}"
    (( conflicts )) && __bp_counts+=" ${__bp_red}~${conflicts}"
    (( staged )) && __bp_counts+=" ${__bp_yellow}+${staged}"
    (( changed )) && __bp_counts+=" ${__bp_yellow}!${changed}"
    (( untracked )) && __bp_counts+=" ${__bp_cyan}?${untracked}"
  }

  # ~/a/b/c/d/e becomes ~/a/…/d/e: the anchor and the last two folders stay readable.
  __bp_short_dir() {
    local p=$PWD drive
    # Git Bash sometimes reports C:/Users/me; show it the MSYS way so ~ matches.
    if [[ $p == [A-Za-z]:/* ]]; then drive=${p:0:1}; p="/${drive,,}${p:2}"; fi
    [ -n "$HOME" ] && case "$p" in "$HOME") p='~' ;; "$HOME"/*) p="~${p#"$HOME"}" ;; esac
    local -a parts
    IFS=/ read -ra parts <<< "$p"
    local n=${#parts[@]}
    if (( n > 5 )); then
      local head=${parts[0]}
      [ -z "$head" ] && head="/${parts[1]}"
      p="$head/…/${parts[n-2]}/${parts[n-1]}"
    fi
    __bp_pwd=$p
  }

  # Folder and branch names reach PS1 only as ${variables}: bash does not
  # expand the value of a variable again, so a branch named $(…) stays text.
  __byndery_theme() {
    local status=${__byndery_last_status:-0}
    local right='' plain='' now part

    __bp_short_dir
    local left="${__bp_dir}"'${__bp_pwd}'"${__bp_reset}"
    __bp_branch=''
    if __bp_git_head && [ -n "$__bp_repo" ]; then
      __bp_git_counts
      local color=$__bp_green
      [ -n "$__bp_counts" ] && color=$__bp_yellow
      left+="  ${color}"'${__bp_branch}'"${__bp_counts}${__bp_reset}"
    fi

    __bp_add() { right+="${right:+  }$1$2${__bp_reset_raw}"; plain+="${plain:+  }$2"; }
    [ "$status" != 0 ] && __bp_add "$__bp_red_raw" "exit $status"
    if [ -n "$__byndery_last_duration" ] && (( __byndery_last_duration >= 2000 )); then
      local ms=$__byndery_last_duration
      if (( ms >= 60000 )); then part="$((ms / 60000))m$(((ms / 1000) % 60))s"
      else part="$((ms / 1000)).$(((ms % 1000) / 100))s"; fi
      __bp_add "$__bp_yellow_raw" "$part"
    fi
    part=${VIRTUAL_ENV##*/}
    [ -z "$part" ] && [ -n "$CONDA_DEFAULT_ENV" ] && [ "$CONDA_DEFAULT_ENV" != base ] && part=$CONDA_DEFAULT_ENV
    [ -n "$part" ] && __bp_add "$__bp_cyan_raw" "$part"
    printf -v now '%(%H:%M:%S)T' -1
    __bp_add "$__bp_dim_raw" "$now"

    # The right side is drawn by saving the cursor, jumping to the last column
    # minus its width, printing, and restoring, all inside \[ \] so bash does
    # not count it towards the prompt's width.
    local jump="\[\e7\e[${COLUMNS:-80}G"
    (( ${#plain} > 1 )) && jump+="\e[$(( ${#plain} - 1 ))D"
    jump+="${right}\e8\]"

    local mark=$__bp_green
    [ "$status" != 0 ] && mark=$__bp_red
    PS1="\n${jump}${left}\n${mark}${__bp_char}${__bp_reset} "
  }

  __byndery_theme_on=1
fi
