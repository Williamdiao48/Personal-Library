# Installing Personal Library

## Download

Get the file for your computer from the [latest release](https://github.com/Williamdiao48/Personal-Library/releases/latest):

| Computer | File |
|---|---|
| Mac with Apple Silicon (M1 or later) | `Personal-Library-<version>-arm64.dmg` |
| Mac with an Intel processor | `Personal-Library-<version>.dmg` |
| Windows | `Personal-Library-Setup-<version>.exe` |
| Linux | `Personal-Library-<version>.AppImage` |

To check which Mac you have, open the Apple menu → About This Mac and look at the "Chip" or "Processor" line.

## First launch

The app isn't code-signed, so macOS and Windows will warn you the first time you open it.

**macOS.** Open the `.dmg` and drag the app into Applications. In Applications, right-click the app and choose Open, then click Open in the dialog. You only need to do this once. If that doesn't work, run this in Terminal and then open the app normally:

```bash
xattr -cr "/Applications/Personal Library.app"
```

**Windows.** Run the installer. If you see "Windows protected your PC", click More info, then Run anyway.

**Linux.** Make the AppImage executable (`chmod +x Personal-Library-*.AppImage`) and run it.

## Updating

On Windows and Linux, the app checks for updates when it starts and offers to install them.

On macOS, automatic updates don't work for unsigned apps, so you update by hand: download the new `.dmg`, drag the app into Applications, and choose Replace. You'll need to repeat the right-click → Open step afterward.

Updating never touches your library.

## Where your data lives

| System | Folder |
|---|---|
| macOS | `~/Library/Application Support/Personal Library/` |
| Windows | `%APPDATA%\Personal Library\` |
| Linux | `~/.config/Personal Library/` |

The folder contains `library.db` (the database) and `content/` (the saved pages, EPUBs, and PDFs).

**Backups.** Settings → Data → Export Library saves everything to one `.plbackup` file. Import it on any machine to restore the library; the app restarts to load it.

**Cloud account.** If you signed up for sync, Settings → Account → Delete account removes the account and everything stored in the cloud for it. The library on your computer stays as it is.

## Uninstalling

Remove the app the usual way for your system: drag it to the Trash on macOS, use Settings → Apps on Windows, or delete the AppImage on Linux.

This leaves your data folder in place, which is how a reinstall gets your library back. To remove everything, also delete the data folder listed above. Export a backup first if you might want the library later.
