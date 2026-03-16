# Troubleshooting

## UI looks messed up / doesn't load

### Step 1: Clear cache
```bash
# In Safari: Develop → Empty Web Storage
# In Chrome: DevTools → Application → Storage → Clear Site Data
```

Then force reload:
- **Mac Safari**: Cmd+Shift+R
- **Chrome**: Ctrl+Shift+F5

### Step 2: Check browser console
1. Press F12 or Cmd+Option+I (Mac)
2. Go to "Console" tab
3. Look for red errors
4. Share the error messages

### Step 3: Check bridge logs
Run the bridge and look for errors:
```bash
$ bun run bridge.ts
[bridge] Listening on http://0.0.0.0:7700
[bridge] Client connected (total=1)
```

If you see error messages, share them.

### Step 4: Test basic functionality
Try without autocomplete:
1. Type a simple message (no `@`)
2. Click Send
3. Does it work?

If yes, the UI itself is fine, issue is just autocomplete.

### Step 5: Check what "messed up" means
- UI doesn't load at all?
- Elements are misaligned/overlapping?
- Text colors are wrong?
- Input area missing?
- Buttons don't work?

## Common Issues

### Issue: Autocomplete popup covers input
**Solution**: Adjust positioning in `client.js`:
```javascript
// In renderAutocomplete()
autocompleteEl.style.bottom = (window.innerHeight - inputRect.top + 4) + "px"; // ← Change 4
```

### Issue: File list not loading
**Solution**: Check bridge can access your project files:
```bash
$ ls -la ~/repos/pi-remote/  # Should show files
```

### Issue: Keyboard navigation doesn't work
**Solution**: Make sure input has focus:
- Click in the message input first
- Then type `@` and use arrow keys

### Issue: "Cannot read property of null" errors
**Solution**: Added in latest version - clear cache and reload

### Issue: Fuzzy matching isn't working
**Solution**: 
- Try exact filename: `@README.md`
- Check file actually exists: `find . -name "*your-file*"`
- Check it's not in ignored directories (node_modules, .git, etc.)

## Debug Tips

### In browser console:
```javascript
// View cached files
fileList

// View autocomplete state
autocompleteState

// Force file list refresh
sendWithId({ type: "list_files", forceRefresh: true })

// View RPC responses
// Filter console to show "list_files"
```

### In bridge terminal:
```bash
# Add logging to bridge.ts to see file scans
# Around line 340, add:
console.log("[list_files]", files.slice(0, 5));
```

## Getting Help

When reporting issues, please include:
1. **What you see** (screenshot or description)
2. **Browser console errors** (exact messages)
3. **Bridge terminal output** (first 20 lines when you start it)
4. **Steps to reproduce** (what did you do?)
5. **Your project type** (Node.js, TypeScript, Python, etc.)

This helps diagnose the issue quickly!
