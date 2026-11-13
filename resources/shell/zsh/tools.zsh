# byndery's MSYS2 on Windows: a command that no system knows can be
# installed on the spot. The router hands a line nobody knows to zsh, so
# zsh's own command_not_found_handler is where the offer is made.
#
# Settings > Shell > "Offer to install missing commands" turns it off
# (BYNDERY_OFFER_INSTALL=0, from the managed file).

# The package that provides a command: an MSYS package of the same name,
# then the UCRT64 build, then pacman's file list when it has been fetched.
__byndery_pkg_for() {
  local c=$1 p
  for p in $c mingw-w64-ucrt-x86_64-$c; do
    pacman -Si -- $p &>/dev/null && { print -r -- $p; return 0 }
  done
  if [[ -r /var/lib/pacman/sync/msys.files ]]; then
    p=$(pacman -Fq -- /usr/bin/$c.exe 2>/dev/null)
    [[ -n $p ]] && { print -r -- ${${(f)p}[1]##*/}; return 0 }
  fi
  return 1
}

command_not_found_handler() {
  local cmd=$1
  print -ru2 -- "zsh: command not found: $cmd"
  [[ ${BYNDERY_OFFER_INSTALL:-1} == 1 && -t 0 && -t 2 ]] || return 127
  (( $+commands[pacman] )) || return 127
  local pkg
  pkg=$(__byndery_pkg_for $cmd) || return 127
  print -nu2 -- $'\e[2m'"byndery: $cmd is in the package $pkg."$'\e[0m'" Install it now? [y/N] "
  local answer
  read -k1 answer
  print -u2
  [[ $answer == [yY] ]] || return 127
  # -Sy fetches the package lists first; byndery's copy may be old.
  pacman -Sy --needed --noconfirm -- $pkg || return 127
  rehash
  "$@"
}
