# byndery shell integration for PowerShell (Windows PowerShell 5.1 and
# PowerShell 7). byndery starts PowerShell with -NoExit and dot-sources this
# file after the user's profile. Like the zsh and bash scripts beside it, it
# reports to the terminal with escape sequences:
#
#   OSC 133;A / B   prompt start and end, for the command marks
#   OSC 133;C / D   command start and its exit code
#   OSC 633;E       the command line, for the command memory
#   OSC 7           the working folder, for the file tree
#
# The user's own prompt is kept and wrapped.

if ($Global:__BynderyLoaded) { return }
$Global:__BynderyLoaded = $true
$Global:__BynderyRunning = $false
$Global:__BynderyEsc = [char]0x1b
$Global:__BynderyBel = [char]0x07
$Global:__BynderyPrompt = $function:prompt

# Escaped the way VS Code's 633;E is: backslash doubled, ; and control characters as \xNN.
function Global:__BynderyEscape([string]$text) {
    $sb = New-Object System.Text.StringBuilder
    foreach ($c in $text.ToCharArray()) {
        if ($c -eq '\') { [void]$sb.Append('\\') }
        elseif ($c -eq ';') { [void]$sb.Append('\x3b') }
        elseif ([int]$c -lt 0x20) { [void]$sb.Append(('\x{0:x2}' -f [int]$c)) }
        else { [void]$sb.Append($c) }
    }
    $sb.ToString()
}

function Global:prompt {
    $ok = $global:?
    $code = $global:LASTEXITCODE
    $e = $Global:__BynderyEsc
    $b = $Global:__BynderyBel
    $out = ''
    if ($Global:__BynderyRunning) {
        $status = if ($ok) { 0 } elseif ($code) { $code } else { 1 }
        $out += "$e]133;D;$status$b"
        $Global:__BynderyRunning = $false
    }
    $loc = $ExecutionContext.SessionState.Path.CurrentLocation
    if ($loc.Provider.Name -eq 'FileSystem') {
        $path = $loc.ProviderPath -replace '\\', '/'
        if (-not $path.StartsWith('/')) { $path = "/$path" }
        $out += "$e]7;file://$env:COMPUTERNAME$path$b"
    }
    $out += "$e]133;A$b"
    $inner = if ($Global:__BynderyPrompt) { & $Global:__BynderyPrompt } else { "PS $($loc.Path)> " }
    $out += "$inner$e]133;B$b"
    $global:LASTEXITCODE = $code
    $out
}

# Enter reports the line and the start of its output before PowerShell runs it.
if (Get-Module -Name PSReadLine) {
    Set-PSReadLineKeyHandler -Chord Enter -ScriptBlock {
        $line = $null
        $cursor = $null
        [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor)
        [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
        if ($line.Trim()) {
            $Global:__BynderyRunning = $true
            $e = $Global:__BynderyEsc
            $b = $Global:__BynderyBel
            [Console]::Write("$e]633;E;$(__BynderyEscape $line)$b$e]133;C$b")
        }
    }
}
