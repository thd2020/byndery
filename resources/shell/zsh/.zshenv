# byndery starts zsh with ZDOTDIR pointing at this folder. Each startup file
# here runs the user's own file of the same name, then keeps ZDOTDIR on this
# folder so zsh comes back for the next one. .zshrc hands ZDOTDIR back for good.

BYNDERY_ZDOTDIR=$ZDOTDIR
: ${BYNDERY_USER_ZDOTDIR:=$HOME}

if [[ -r $BYNDERY_USER_ZDOTDIR/.zshenv ]]; then
  ZDOTDIR=$BYNDERY_USER_ZDOTDIR
  source $BYNDERY_USER_ZDOTDIR/.zshenv
  # The user's .zshenv may move ZDOTDIR; their remaining files live there.
  BYNDERY_USER_ZDOTDIR=$ZDOTDIR
  ZDOTDIR=$BYNDERY_ZDOTDIR
fi
