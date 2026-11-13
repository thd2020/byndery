// byndery-handoff.exe: makes byndery the default terminal on Windows 11.
//
// When a console program starts on its own (cmd or PowerShell from the Start
// menu, a script double-clicked in Explorer, Win+R), the inbox console host
// reads HKCU\Console\%%Startup. DelegationConsole names the console server that
// takes over (Windows Terminal's OpenConsole) and DelegationTerminal the
// terminal that shows it. OpenConsole creates the DelegationTerminal class over
// COM and calls ITerminalHandoff3::EstablishPtyHandoff (ITerminalHandoff2 with
// an older Windows Terminal), passing the console as pipes. The interfaces come
// from microsoft/terminal's src/host/proxy/ITerminalHandoff.idl; the proxy that
// carries them between processes is installed with Windows Terminal.
//
// This program is that class. COM starts it with -Embedding; it takes each
// console it is handed and passes it to byndery over a named pipe, starting
// byndery when it is not running. The same program changes the registry for
// the installer and for Settings:
//
//   byndery-handoff.exe --status      JSON: supported, enabled, terminalProxy, build
//   byndery-handoff.exe --enable      make byndery the default terminal
//   byndery-handoff.exe --disable     give the choice back to what it was before
//   byndery-handoff.exe --refresh     point the registration at this copy, if enabled
//   byndery-handoff.exe --can-enable  exit code 0 when --enable would work and is not on yet
//
// It is a GUI-subsystem program on purpose: a console program here would ask
// for a console of its own, and that console would be handed to us again.

#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <objbase.h>
#include <oleauto.h>
#include <shellapi.h>

#include <atomic>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

// ---------------------------------------------------------------------------
// Identities. Never change byndery's CLSID: Windows keeps it in the registry.

static const CLSID CLSID_BynderyHandoff = {0xF4426754, 0x7044, 0x4E2A, {0xA1, 0x69, 0xEA, 0x8A, 0x4D, 0x3E, 0x9D, 0xE5}};
static const wchar_t* const BYNDERY_CLSID = L"{F4426754-7044-4E2A-A169-EA8A4D3E9DE5}";

static const IID IID_ITerminalHandoff2 = {0xAA6B364F, 0x4A50, 0x4176, {0x90, 0x02, 0x0A, 0xE7, 0x55, 0xE7, 0xB5, 0xEF}};
static const IID IID_ITerminalHandoff3 = {0x6F23DA90, 0x15C5, 0x4203, {0x9D, 0xB0, 0x64, 0xE7, 0x3F, 0x1B, 0x1B, 0x00}};

// Windows Terminal's console servers (OpenConsole): stable, Preview, Canary.
static const wchar_t* const OPENCONSOLE_STABLE = L"{2EACA947-7F5F-4CFA-BA87-8F7FBEEFBE69}";
static const wchar_t* const OPENCONSOLE_KNOWN[] = {
    L"{2EACA947-7F5F-4CFA-BA87-8F7FBEEFBE69}",
    L"{06EC847C-C0A5-46B8-92CB-7C92F6E35CD5}",
    L"{A854D02A-F2FE-44A5-BB24-D03F4CF830D4}",
};
// "Let Windows decide".
static const wchar_t* const UNDECIDED = L"{00000000-0000-0000-0000-000000000000}";

static const wchar_t* const STARTUP_KEY = L"Console\\%%Startup";
static const wchar_t* const BACKUP_KEY = L"Software\\byndery\\DefaultTerminal";
static const DWORD FIRST_SUPPORTED_BUILD = 22621;  // Windows 11 22H2

// ---------------------------------------------------------------------------
// TERMINAL_STARTUP_INFO and the handoff interfaces, as in ITerminalHandoff.idl.

struct TERMINAL_STARTUP_INFO {
  BSTR pszTitle;
  BSTR pszIconPath;
  LONG iconIndex;
  DWORD dwX;
  DWORD dwY;
  DWORD dwXSize;
  DWORD dwYSize;
  DWORD dwXCountChars;
  DWORD dwYCountChars;
  DWORD dwFillAttribute;
  DWORD dwFlags;
  WORD wShowWindow;
};

struct ITerminalHandoff2 : public IUnknown {
  virtual HRESULT STDMETHODCALLTYPE EstablishPtyHandoff(HANDLE in, HANDLE out, HANDLE signal, HANDLE ref, HANDLE server,
                                                        HANDLE client, TERMINAL_STARTUP_INFO startupInfo) = 0;
};

struct ITerminalHandoff3 : public IUnknown {
  virtual HRESULT STDMETHODCALLTYPE EstablishPtyHandoff(HANDLE* in, HANDLE* out, HANDLE signal, HANDLE reference,
                                                        HANDLE server, HANDLE client,
                                                        const TERMINAL_STARTUP_INFO* startupInfo) = 0;
};

// ---------------------------------------------------------------------------
// Small helpers.

static std::string utf8(const std::wstring& text) {
  if (text.empty()) return std::string();
  int n = WideCharToMultiByte(CP_UTF8, 0, text.data(), (int)text.size(), nullptr, 0, nullptr, nullptr);
  std::string out(n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, text.data(), (int)text.size(), &out[0], n, nullptr, nullptr);
  return out;
}

static std::string jsonString(const std::wstring& text) {
  std::string in = utf8(text), out = "\"";
  for (unsigned char c : in) {
    if (c == '"' || c == '\\') {
      out += '\\';
      out += (char)c;
    } else if (c < 0x20) {
      char buf[8];
      wsprintfA(buf, "\\u%04x", c);
      out += buf;
    } else {
      out += (char)c;
    }
  }
  return out + "\"";
}

static void writeStdout(const std::string& text) {
  HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
  if (!out || out == INVALID_HANDLE_VALUE) return;
  DWORD written = 0;
  WriteFile(out, text.data(), (DWORD)text.size(), &written, nullptr);
}

static std::wstring selfPath() {
  std::wstring path(MAX_PATH, L'\0');
  for (;;) {
    DWORD n = GetModuleFileNameW(nullptr, &path[0], (DWORD)path.size());
    if (n == 0) return std::wstring();
    if (n < path.size()) {
      path.resize(n);
      return path;
    }
    path.resize(path.size() * 2);
  }
}

static std::wstring parentDir(const std::wstring& path) {
  size_t slash = path.find_last_of(L"\\/");
  return slash == std::wstring::npos ? std::wstring() : path.substr(0, slash);
}

static HANDLE duplicate(HANDLE handle) {
  HANDLE copy = nullptr;
  if (!handle || handle == INVALID_HANDLE_VALUE) return nullptr;
  if (!DuplicateHandle(GetCurrentProcess(), handle, GetCurrentProcess(), &copy, 0, FALSE, DUPLICATE_SAME_ACCESS)) return nullptr;
  return copy;
}

static void closeHandle(HANDLE& handle) {
  if (handle && handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
  handle = nullptr;
}

// ---------------------------------------------------------------------------
// Registry.

static bool readString(HKEY root, const wchar_t* subkey, const wchar_t* name, std::wstring& value) {
  wchar_t buf[512];
  DWORD size = sizeof(buf);
  if (RegGetValueW(root, subkey, name, RRF_RT_REG_SZ, nullptr, buf, &size) != ERROR_SUCCESS) return false;
  value = buf;
  return true;
}

static bool writeString(HKEY root, const wchar_t* subkey, const wchar_t* name, const std::wstring& value) {
  HKEY key;
  if (RegCreateKeyExW(root, subkey, 0, nullptr, 0, KEY_SET_VALUE, nullptr, &key, nullptr) != ERROR_SUCCESS) return false;
  LONG r = RegSetValueExW(key, name, 0, REG_SZ, (const BYTE*)value.c_str(), (DWORD)((value.size() + 1) * sizeof(wchar_t)));
  RegCloseKey(key);
  return r == ERROR_SUCCESS;
}

static bool sameGuid(const std::wstring& a, const wchar_t* b) { return _wcsicmp(a.c_str(), b) == 0; }

static std::wstring classKey() { return std::wstring(L"Software\\Classes\\CLSID\\") + BYNDERY_CLSID; }

static DWORD windowsBuild() {
  std::wstring build;
  if (!readString(HKEY_LOCAL_MACHINE, L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion", L"CurrentBuildNumber", build)) return 0;
  return (DWORD)_wtoi(build.c_str());
}

static bool supported() { return windowsBuild() >= FIRST_SUPPORTED_BUILD; }

static bool isEnabled() {
  std::wstring terminal;
  return readString(HKEY_CURRENT_USER, STARTUP_KEY, L"DelegationTerminal", terminal) && sameGuid(terminal, BYNDERY_CLSID);
}

// Whether COM can marshal the handoff calls: the proxy comes with Windows Terminal.
static bool terminalProxyInstalled() {
  bool ok = false;
  if (SUCCEEDED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) {
    CLSID ps;
    ok = SUCCEEDED(CoGetPSClsid(IID_ITerminalHandoff3, &ps)) || SUCCEEDED(CoGetPSClsid(IID_ITerminalHandoff2, &ps));
    CoUninitialize();
  }
  return ok;
}

static bool registerClass() {
  std::wstring key = classKey();
  std::wstring server = L"\"" + selfPath() + L"\"";
  return writeString(HKEY_CURRENT_USER, key.c_str(), nullptr, L"byndery console handoff") &&
         writeString(HKEY_CURRENT_USER, (key + L"\\LocalServer32").c_str(), nullptr, server);
}

static int enable() {
  if (!supported()) {
    writeStdout("byndery can be the default terminal on Windows 11 22H2 and later.\n");
    return 2;
  }
  std::wstring console, terminal;
  bool hasConsole = readString(HKEY_CURRENT_USER, STARTUP_KEY, L"DelegationConsole", console);
  bool hasTerminal = readString(HKEY_CURRENT_USER, STARTUP_KEY, L"DelegationTerminal", terminal);
  // Remember what was chosen before, so turning byndery off gives it back.
  if (!(hasTerminal && sameGuid(terminal, BYNDERY_CLSID))) {
    writeString(HKEY_CURRENT_USER, BACKUP_KEY, L"PreviousConsole", hasConsole ? console : UNDECIDED);
    writeString(HKEY_CURRENT_USER, BACKUP_KEY, L"PreviousTerminal", hasTerminal ? terminal : UNDECIDED);
  }
  // Keep a Windows Terminal console server the user already chose (Preview, Canary).
  std::wstring chosen = OPENCONSOLE_STABLE;
  if (hasConsole)
    for (const wchar_t* known : OPENCONSOLE_KNOWN)
      if (sameGuid(console, known)) chosen = known;
  if (!registerClass() || !writeString(HKEY_CURRENT_USER, STARTUP_KEY, L"DelegationConsole", chosen) ||
      !writeString(HKEY_CURRENT_USER, STARTUP_KEY, L"DelegationTerminal", BYNDERY_CLSID)) {
    writeStdout("Could not write the default terminal to the registry.\n");
    return 1;
  }
  return 0;
}

static int disable() {
  if (isEnabled()) {
    std::wstring console, terminal;
    bool restore = readString(HKEY_CURRENT_USER, BACKUP_KEY, L"PreviousConsole", console) &&
                   readString(HKEY_CURRENT_USER, BACKUP_KEY, L"PreviousTerminal", terminal) &&
                   !sameGuid(terminal, BYNDERY_CLSID);
    if (!restore) console = terminal = UNDECIDED;
    if (!writeString(HKEY_CURRENT_USER, STARTUP_KEY, L"DelegationConsole", console) ||
        !writeString(HKEY_CURRENT_USER, STARTUP_KEY, L"DelegationTerminal", terminal)) {
      writeStdout("Could not restore the previous default terminal.\n");
      return 1;
    }
  }
  RegDeleteTreeW(HKEY_CURRENT_USER, classKey().c_str());
  RegDeleteTreeW(HKEY_CURRENT_USER, BACKUP_KEY);
  return 0;
}

static int refresh() {
  if (isEnabled() && !registerClass()) return 1;
  return 0;
}

static int status() {
  DWORD build = windowsBuild();
  std::string json = "{\"supported\":";
  json += build >= FIRST_SUPPORTED_BUILD ? "true" : "false";
  json += ",\"enabled\":";
  json += isEnabled() ? "true" : "false";
  json += ",\"terminalProxy\":";
  json += terminalProxyInstalled() ? "true" : "false";
  json += ",\"build\":" + std::to_string(build) + "}\n";
  writeStdout(json);
  return 0;
}

// ---------------------------------------------------------------------------
// Overlapped I/O on the pipe to byndery. One thread reads it while others
// write, which a synchronous handle would serialise.

static bool pipeWrite(HANDLE pipe, const void* data, DWORD size) {
  OVERLAPPED ov = {};
  ov.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!ov.hEvent) return false;
  const char* p = (const char*)data;
  bool ok = true;
  while (size > 0) {
    DWORD done = 0;
    ResetEvent(ov.hEvent);
    if (!WriteFile(pipe, p, size, nullptr, &ov) && GetLastError() != ERROR_IO_PENDING) {
      ok = false;
      break;
    }
    if (!GetOverlappedResult(pipe, &ov, &done, TRUE) || done == 0) {
      ok = false;
      break;
    }
    p += done;
    size -= done;
  }
  CloseHandle(ov.hEvent);
  return ok;
}

static bool pipeReadExact(HANDLE pipe, void* data, DWORD size) {
  OVERLAPPED ov = {};
  ov.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!ov.hEvent) return false;
  char* p = (char*)data;
  bool ok = true;
  while (size > 0) {
    DWORD done = 0;
    ResetEvent(ov.hEvent);
    if (!ReadFile(pipe, p, size, nullptr, &ov) && GetLastError() != ERROR_IO_PENDING) {
      if (GetLastError() != ERROR_MORE_DATA) {
        ok = false;
        break;
      }
    }
    if (!GetOverlappedResult(pipe, &ov, &done, TRUE) && GetLastError() != ERROR_MORE_DATA) {
      ok = false;
      break;
    }
    if (done == 0) {
      ok = false;
      break;
    }
    p += done;
    size -= done;
  }
  CloseHandle(ov.hEvent);
  return ok;
}

// ---------------------------------------------------------------------------
// Sessions. The pipe carries frames both ways: one type byte, a 4-byte
// little-endian length, then the payload.
//   helper -> byndery: 1 output bytes, 2 exit code (int32)
//   byndery -> helper: 1 input bytes, 2 resize (uint16 cols, uint16 rows), 3 close
// Before the first frame the helper sends one line of JSON describing the console.

enum : uint8_t { FRAME_DATA = 1, FRAME_EXIT = 2, FRAME_RESIZE = 2, FRAME_CLOSE = 3 };

static std::atomic<long> g_sessions{0};
static std::atomic<ULONGLONG> g_lastActivity{0};
static HANDLE g_wake = nullptr;

static void touch() {
  g_lastActivity = GetTickCount64();
  if (g_wake) SetEvent(g_wake);
}

struct Session {
  HANDLE toConsole = nullptr;    // what the user types
  HANDLE fromConsole = nullptr;  // what the console prints
  HANDLE signal = nullptr;
  HANDLE reference = nullptr;
  HANDLE server = nullptr;
  HANDLE client = nullptr;
  HANDLE app = nullptr;          // the pipe to byndery
  HANDLE outputDone = nullptr;
  CRITICAL_SECTION sendLock;
  std::wstring title;
  bool hidden = false;
  DWORD cols = 0;
  DWORD rows = 0;

  Session() { InitializeCriticalSection(&sendLock); }
  ~Session() {
    closeHandle(toConsole);
    closeHandle(fromConsole);
    closeHandle(signal);
    closeHandle(reference);
    closeHandle(server);
    closeHandle(client);
    closeHandle(app);
    closeHandle(outputDone);
    DeleteCriticalSection(&sendLock);
  }

  bool send(uint8_t type, const void* data, DWORD size) {
    uint8_t head[5] = {type, (uint8_t)size, (uint8_t)(size >> 8), (uint8_t)(size >> 16), (uint8_t)(size >> 24)};
    EnterCriticalSection(&sendLock);
    bool ok = pipeWrite(app, head, sizeof(head)) && (size == 0 || pipeWrite(app, data, size));
    LeaveCriticalSection(&sendLock);
    return ok;
  }
};

static std::wstring pipeName() {
  wchar_t user[257];
  DWORD size = 257;
  if (!GetUserNameW(user, &size)) user[0] = 0;
  return std::wstring(L"\\\\.\\pipe\\byndery-handoff-") + user;
}

// The pipe must belong to a process of this user, or another account could
// squat the name and read the console.
static bool serverIsSameUser(HANDLE pipe) {
  ULONG pid = 0;
  if (!GetNamedPipeServerProcessId(pipe, &pid)) return false;
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process) return false;
  bool same = false;
  HANDLE theirs = nullptr, ours = nullptr;
  if (OpenProcessToken(process, TOKEN_QUERY, &theirs) && OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &ours)) {
    BYTE a[SECURITY_MAX_SID_SIZE + sizeof(TOKEN_USER)], b[SECURITY_MAX_SID_SIZE + sizeof(TOKEN_USER)];
    DWORD n = 0;
    if (GetTokenInformation(theirs, TokenUser, a, sizeof(a), &n) && GetTokenInformation(ours, TokenUser, b, sizeof(b), &n))
      same = EqualSid(((TOKEN_USER*)a)->User.Sid, ((TOKEN_USER*)b)->User.Sid) != FALSE;
  }
  if (theirs) CloseHandle(theirs);
  if (ours) CloseHandle(ours);
  AllowSetForegroundWindow(pid);
  CloseHandle(process);
  return same;
}

static HANDLE tryConnect(const std::wstring& name) {
  HANDLE pipe = CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
                            FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr);
  if (pipe == INVALID_HANDLE_VALUE) {
    if (GetLastError() == ERROR_PIPE_BUSY) WaitNamedPipeW(name.c_str(), 2000);
    return nullptr;
  }
  if (!serverIsSameUser(pipe)) {
    CloseHandle(pipe);
    return nullptr;
  }
  return pipe;
}

static bool launchByndery() {
  // resources\handoff\byndery-handoff.exe -> byndery.exe in the install folder.
  std::wstring dir = parentDir(parentDir(parentDir(selfPath())));
  std::wstring exe = dir + L"\\byndery.exe";
  if (GetFileAttributesW(exe.c_str()) == INVALID_FILE_ATTRIBUTES) return false;
  std::wstring command = L"\"" + exe + L"\" --handoff";
  STARTUPINFOW si = {};
  si.cb = sizeof(si);
  PROCESS_INFORMATION pi = {};
  if (!CreateProcessW(exe.c_str(), &command[0], nullptr, nullptr, FALSE, 0, nullptr, dir.c_str(), &si, &pi)) return false;
  AllowSetForegroundWindow(pi.dwProcessId);
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
  return true;
}

static HANDLE connectToByndery() {
  std::wstring name = pipeName();
  if (HANDLE pipe = tryConnect(name)) return pipe;
  if (!launchByndery()) return nullptr;
  for (int i = 0; i < 120; i++) {  // a cold start can take a while
    Sleep(250);
    if (HANDLE pipe = tryConnect(name)) return pipe;
  }
  return nullptr;
}

static std::wstring clientName(HANDLE client) {
  wchar_t path[MAX_PATH * 2];
  DWORD size = MAX_PATH * 2;
  if (!QueryFullProcessImageNameW(client, 0, path, &size)) return std::wstring();
  std::wstring full(path, size);
  size_t slash = full.find_last_of(L"\\/");
  return slash == std::wstring::npos ? full : full.substr(slash + 1);
}

static DWORD WINAPI outputThread(LPVOID param) {
  Session* s = (Session*)param;
  std::vector<char> buf(64 * 1024);
  for (;;) {
    DWORD got = 0;
    if (!ReadFile(s->fromConsole, buf.data(), (DWORD)buf.size(), &got, nullptr) || got == 0) break;
    if (!s->send(FRAME_DATA, buf.data(), got)) break;
  }
  SetEvent(s->outputDone);
  return 0;
}

static DWORD WINAPI inputThread(LPVOID param) {
  Session* s = (Session*)param;
  std::vector<char> buf;
  for (;;) {
    uint8_t head[5];
    if (!pipeReadExact(s->app, head, sizeof(head))) break;
    DWORD size = head[1] | (head[2] << 8) | (head[3] << 16) | ((DWORD)head[4] << 24);
    if (size > 16 * 1024 * 1024) break;
    buf.resize(size);
    if (size && !pipeReadExact(s->app, buf.data(), size)) break;
    if (head[0] == FRAME_DATA) {
      DWORD written = 0;
      if (size && !WriteFile(s->toConsole, buf.data(), size, &written, nullptr)) break;
    } else if (head[0] == FRAME_RESIZE && size >= 4) {
      // PTY_SIGNAL_RESIZE_WINDOW, then the width and height, as ConPTY writes it.
      const uint8_t* b = (const uint8_t*)buf.data();
      uint16_t packet[3] = {8, (uint16_t)(b[0] | (b[1] << 8)), (uint16_t)(b[2] | (b[3] << 8))};
      DWORD written = 0;
      WriteFile(s->signal, packet, sizeof(packet), &written, nullptr);
    } else if (head[0] == FRAME_CLOSE) {
      TerminateProcess(s->client, 1);
    }
  }
  return 0;
}

static DWORD WINAPI sessionThread(LPVOID param) {
  Session* s = (Session*)param;
  s->app = connectToByndery();
  if (s->app) {
    std::wstring name = clientName(s->client);
    std::string header = "{\"version\":1,\"title\":" + jsonString(s->title) + ",\"program\":" + jsonString(name) +
                         ",\"pid\":" + std::to_string(GetProcessId(s->client)) + ",\"cols\":" + std::to_string(s->cols) +
                         ",\"rows\":" + std::to_string(s->rows) + ",\"hidden\":" + (s->hidden ? "true" : "false") + "}\n";
    if (pipeWrite(s->app, header.data(), (DWORD)header.size())) {
      HANDLE output = CreateThread(nullptr, 0, outputThread, s, 0, nullptr);
      HANDLE input = CreateThread(nullptr, 0, inputThread, s, 0, nullptr);
      if (output && input) {
        // Ends when the program exits, or when byndery closes the tab or goes away.
        HANDLE waits[2] = {s->client, input};
        DWORD which = WaitForMultipleObjects(2, waits, FALSE, INFINITE);
        if (which == WAIT_OBJECT_0 + 1) TerminateProcess(s->client, 1);
        WaitForSingleObject(s->client, 5000);
        // Let the last output through before reporting the exit.
        WaitForSingleObject(s->outputDone, 500);
        DWORD code = 1;
        GetExitCodeProcess(s->client, &code);
        s->send(FRAME_EXIT, &code, sizeof(code));
      }
      // Closing the signal and reference handles ends the console server,
      // which closes its end of the output pipe.
      closeHandle(s->signal);
      closeHandle(s->reference);
      closeHandle(s->server);
      if (output) {
        if (WaitForSingleObject(output, 2000) == WAIT_TIMEOUT) {
          CancelSynchronousIo(output);
          WaitForSingleObject(output, 2000);
        }
        CloseHandle(output);
      }
      if (input) {
        CancelIoEx(s->app, nullptr);
        if (WaitForSingleObject(input, 2000) == WAIT_TIMEOUT) {
          CancelSynchronousIo(input);
          WaitForSingleObject(input, 2000);
        }
        CloseHandle(input);
      }
    }
  } else {
    // No byndery to show it: end the program rather than leave it running unseen.
    TerminateProcess(s->client, 1);
  }
  delete s;
  g_sessions--;
  touch();
  return 0;
}

static HRESULT adopt(Session* s, const TERMINAL_STARTUP_INFO* info) {
  if (info) {
    if (info->pszTitle) s->title.assign(info->pszTitle, SysStringLen(info->pszTitle));
    s->hidden = (info->dwFlags & STARTF_USESHOWWINDOW) && info->wShowWindow == SW_HIDE;
    if (info->dwFlags & STARTF_USECOUNTCHARS) {
      s->cols = info->dwXCountChars;
      s->rows = info->dwYCountChars;
    }
  }
  s->outputDone = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!s->toConsole || !s->fromConsole || !s->signal || !s->reference || !s->server || !s->client || !s->outputDone) {
    delete s;
    return E_HANDLE;
  }
  g_sessions++;
  touch();
  HANDLE thread = CreateThread(nullptr, 0, sessionThread, s, 0, nullptr);
  if (!thread) {
    delete s;
    g_sessions--;
    return HRESULT_FROM_WIN32(GetLastError());
  }
  CloseHandle(thread);
  return S_OK;
}

// ---------------------------------------------------------------------------
// COM objects.

class Handoff final : public ITerminalHandoff3, public ITerminalHandoff2 {
  std::atomic<ULONG> refs{1};

 public:
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** object) override {
    if (!object) return E_POINTER;
    if (IsEqualIID(iid, IID_IUnknown) || IsEqualIID(iid, IID_ITerminalHandoff3))
      *object = static_cast<ITerminalHandoff3*>(this);
    else if (IsEqualIID(iid, IID_ITerminalHandoff2))
      *object = static_cast<ITerminalHandoff2*>(this);
    else {
      *object = nullptr;
      return E_NOINTERFACE;
    }
    AddRef();
    return S_OK;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return ++refs; }
  ULONG STDMETHODCALLTYPE Release() override {
    ULONG n = --refs;
    if (n == 0) delete this;
    return n;
  }

  // Version 3: the terminal makes the input and output pipes and returns the console's ends.
  HRESULT STDMETHODCALLTYPE EstablishPtyHandoff(HANDLE* in, HANDLE* out, HANDLE signal, HANDLE reference, HANDLE server,
                                                HANDLE client, const TERMINAL_STARTUP_INFO* startupInfo) override {
    if (!in || !out) return E_INVALIDARG;
    HANDLE consoleIn = nullptr, ourIn = nullptr, ourOut = nullptr, consoleOut = nullptr;
    if (!CreatePipe(&consoleIn, &ourIn, nullptr, 0)) return HRESULT_FROM_WIN32(GetLastError());
    if (!CreatePipe(&ourOut, &consoleOut, nullptr, 0)) {
      HRESULT hr = HRESULT_FROM_WIN32(GetLastError());
      CloseHandle(consoleIn);
      CloseHandle(ourIn);
      return hr;
    }
    Session* s = new Session();
    s->toConsole = ourIn;
    s->fromConsole = ourOut;
    s->signal = duplicate(signal);
    s->reference = duplicate(reference);
    s->server = duplicate(server);
    s->client = duplicate(client);
    HRESULT hr = adopt(s, startupInfo);
    if (FAILED(hr)) {
      CloseHandle(consoleIn);
      CloseHandle(consoleOut);
      return hr;
    }
    // COM marshals these to the console server and closes our copies.
    *in = consoleIn;
    *out = consoleOut;
    return S_OK;
  }

  // Version 2: the console made the pipes; the handles are lent for the call.
  HRESULT STDMETHODCALLTYPE EstablishPtyHandoff(HANDLE in, HANDLE out, HANDLE signal, HANDLE ref, HANDLE server,
                                                HANDLE client, TERMINAL_STARTUP_INFO startupInfo) override {
    Session* s = new Session();
    s->toConsole = duplicate(in);
    s->fromConsole = duplicate(out);
    s->signal = duplicate(signal);
    s->reference = duplicate(ref);
    s->server = duplicate(server);
    s->client = duplicate(client);
    return adopt(s, &startupInfo);
  }
};

class Factory final : public IClassFactory {
 public:
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** object) override {
    if (!object) return E_POINTER;
    if (IsEqualIID(iid, IID_IUnknown) || IsEqualIID(iid, IID_IClassFactory)) {
      *object = static_cast<IClassFactory*>(this);
      return S_OK;
    }
    *object = nullptr;
    return E_NOINTERFACE;
  }
  // The factory lives as long as the process.
  ULONG STDMETHODCALLTYPE AddRef() override { return 2; }
  ULONG STDMETHODCALLTYPE Release() override { return 1; }
  HRESULT STDMETHODCALLTYPE CreateInstance(IUnknown* outer, REFIID iid, void** object) override {
    if (!object) return E_POINTER;
    *object = nullptr;
    if (outer) return CLASS_E_NOAGGREGATION;
    touch();
    Handoff* handoff = new Handoff();
    HRESULT hr = handoff->QueryInterface(iid, object);
    handoff->Release();
    return hr;
  }
  HRESULT STDMETHODCALLTYPE LockServer(BOOL) override {
    touch();
    return S_OK;
  }
};

static int serve() {
  // Stay a while after the last console, so a burst of launches shares one process.
  const ULONGLONG IDLE_MS = 15000;
  g_wake = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  touch();
  if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) return 1;
  static Factory factory;
  DWORD cookie = 0;
  if (FAILED(CoRegisterClassObject(CLSID_BynderyHandoff, &factory, CLSCTX_LOCAL_SERVER, REGCLS_MULTIPLEUSE, &cookie))) {
    CoUninitialize();
    return 1;
  }
  for (;;) {
    WaitForSingleObject(g_wake, 1000);
    if (g_sessions == 0 && GetTickCount64() - g_lastActivity > IDLE_MS) break;
  }
  CoRevokeClassObject(cookie);
  while (g_sessions > 0) WaitForSingleObject(g_wake, 1000);
  CoUninitialize();
  return 0;
}

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
  int argc = 0;
  wchar_t** argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  std::wstring command = argc > 1 && argv ? argv[1] : L"";
  if (argv) LocalFree(argv);

  if (_wcsicmp(command.c_str(), L"-Embedding") == 0 || _wcsicmp(command.c_str(), L"/Embedding") == 0) return serve();
  if (command == L"--status") return status();
  if (command == L"--enable") return enable();
  if (command == L"--disable") return disable();
  if (command == L"--refresh") return refresh();
  if (command == L"--can-enable") return supported() && !isEnabled() ? 0 : 1;
  writeStdout("usage: byndery-handoff.exe --status | --enable | --disable | --refresh | --can-enable\n");
  return 64;
}
