# File Autocomplete - Quick Reference

## For Users

### Typing
```
@file        →  Search for "file" in project
@src/main    →  Search "src/main" path
@README      →  Match README.md, README.txt, etc.
```

### Keyboard
| Key | Action |
|-----|--------|
| ↑↓ | Navigate suggestions |
| Enter / Tab | Select highlighted file |
| Escape | Close autocomplete |
| Click | Select directly |

## For Developers

### File Structure

```
bridge.ts
├─ listFilesRecursive()       // Scan filesystem
├─ getFileList()              // Cache management
└─ handleClientMessage()
   └─ "list_files" handler    // RPC endpoint

public/client.js
├─ autocompleteState          // UI state
├─ fuzzyScore()               // Match scoring
├─ updateAutocompleteSuggestions()  // Filter
├─ renderAutocomplete()       // Display
└─ msgInputEl.addEventListener("input")  // Trigger

public/style.css
├─ #file-autocomplete         // Popup container
├─ .file-autocomplete-item    // Item styling
└─ .file-autocomplete-item.focused  // Highlight

public/index.html
└─ <div id="file-autocomplete"></div>  // DOM mount
```

### Adding to Ignored Directories

**bridge.ts:**
```typescript
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  // Add here ↓
  ".mydir",
]);
```

### Adjusting Cache TTL

**bridge.ts:**
```typescript
const FILE_LIST_CACHE_TTL = 5000; // milliseconds
// Increase for slower disks, decrease for faster updates
```

### Tweaking Fuzzy Scoring

**public/client.js, fuzzyScore():**
```javascript
const consecutiveBonus = prevMatchIdx === i - 1 ? 10 : 0;    // ← Match grouping
const wordBoundaryBonus = i === 0 || s[i - 1] === "/" ? 50 : 0; // ← Path matching
const posBonus = Math.max(0, 100 - i);  // ← Early matches preferred
```

### Changing Max Suggestions

**public/client.js, updateAutocompleteSuggestions():**
```javascript
.slice(0, 15)  // ← Change 15 to desired count (max suggestions)
```

**public/client.js, updateAutocompleteSuggestions():**
```javascript
autocompleteState.suggestions = fileList.slice(0, 15);  // ← When empty query
```

### Popup Positioning

**public/client.js, renderAutocomplete():**
```javascript
const inputRect = msgInputEl.getBoundingClientRect();
autocompleteEl.style.bottom = (window.innerHeight - inputRect.top + 4) + "px"; // ↑ Distance from input
autocompleteEl.style.left = "12px";   // ← Left margin
autocompleteEl.style.right = "12px";  // ← Right margin
```

### CSS Customization

**public/style.css:**
```css
#file-autocomplete {
  border: 1px solid var(--accent);     /* Border color */
  max-height: 200px;                   /* Popup height */
  z-index: 150;                        /* Layer depth */
}

.file-autocomplete-item {
  padding: 8px 12px;                   /* Item spacing */
  font-size: 12px;                     /* Text size */
}

.file-autocomplete-item:hover,
.file-autocomplete-item.focused {
  background: var(--surface2);         /* Highlight color */
  color: var(--accent);                /* Highlight text */
}
```

### RPC Protocol

**Client → Bridge:**
```json
{ "type": "list_files", "id": "client-123", "forceRefresh": false }
```

**Bridge → Client:**
```json
{
  "type": "response",
  "command": "list_files",
  "success": true,
  "id": "client-123",
  "data": {
    "files": ["README.md", "src/main.ts", "package.json"]
  }
}
```

### Debugging

**In browser console:**
```javascript
fileList                           // View current file cache
autocompleteState                  // View current UI state
sendWithId({ type: "list_files" }) // Force refresh files
```

**In bridge terminal:**
```bash
# Add console.log to bridge.ts:
console.log("[file-list]", files.slice(0, 5)); // Log first 5 files
```

## Common Issues & Fixes

### Files not showing up
- Check ignored directories in `IGNORED_DIRS`
- Verify bridge has file system access to CWD
- Check file permissions

### Autocomplete too slow
- Increase `FILE_LIST_CACHE_TTL` (more cached)
- Reduce max suggestions (`.slice(0, 15)`)
- Check filesystem size (`du -sh .`)

### Popup in wrong position
- Adjust `bottom`, `left`, `right` in `renderAutocomplete()`
- Check for competing Z-index elements

### Fuzzy matching too strict/loose
- Adjust bonus values in `fuzzyScore()`
- Increase `consecutiveBonus` for stricter matching
- Increase `wordBoundaryBonus` for path-heavy matching

## Stats

- **Lines of code**: ~350 (bridge) + ~250 (client) + ~50 (CSS)
- **Network overhead**: ~50KB initial (file list), ~1KB per query response
- **Memory**: ~1-5MB (file list cache, depends on project size)
- **File discovery time**: ~10-500ms (depends on disk speed and project size)
