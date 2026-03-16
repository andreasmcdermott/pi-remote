# File Reference Autocomplete Implementation Summary

## Overview

I've successfully implemented fuzzy file reference autocomplete for pi-remote's web UI, matching the TUI experience. Type `@` in the message input to fuzzy-search project files.

## Changes Made

### 1. **bridge.ts** - Backend file listing

**Added file listing infrastructure:**

```typescript
// Constants
const IGNORED_DIRS = new Set([...]) // node_modules, .git, dist, etc.
const IGNORED_FILES = new Set([...]) // .DS_Store, etc.
const FILE_LIST_CACHE_TTL = 5000     // 5 second cache

// Functions
getFileList(forceRefresh?: boolean): string[]     // Get cached file list
listFilesRecursive(dir, prefix): string[]         // Recursive DFS traversal
```

**Added RPC handler:**
- Responds to `list_files` requests from clients
- Returns cached file list (5 second TTL) for efficiency
- Handles multiple concurrent clients

**Key features:**
- Recursive directory traversal with smart ignore patterns
- Caching prevents excessive filesystem scanning
- Excludes hidden files and common build/dependency directories

### 2. **public/client.js** - Frontend autocomplete logic

**Core components:**

```javascript
// State management
autocompleteState {
  visible: boolean
  query: string              // Text after @
  suggestions: string[]      // Matched files
  selectedIdx: number        // Keyboard selection
  atPos: number             // Position of @ in input
}

fileList: string[]           // Cache of all project files
```

**Functions:**

- `fuzzyScore(query, str)` - Sublime Text-style fuzzy matching
  - Consecutive character bonus (+10)
  - Word boundary bonus after "/" (+50)
  - Position bonus for early matches (+100 - position)
  
- `loadFileList()` - Fetches file list from bridge on first `@`
  
- `updateAutocompleteSuggestions(query)` - Filters and scores files
  - Real-time fuzzy filtering
  - Top 15 suggestions returned
  
- `renderAutocomplete()` - Renders popup above input
  - Positioned fixed, responsive width
  - Shows max 200px height with scroll
  
- `selectAutocompleteSuggestion(idx)` - Inserts selected file
  - Replaces `@` + query with `@filename`
  - Maintains cursor position

**Input handling:**
- Listens for `@` character in textarea
- Tracks query text between `@` and cursor
- Stops at whitespace (space, newline)
- Validates character set (alphanumeric, `.`, `/`, `-`, `_`)

**Keyboard navigation:**
- ↑↓ arrow keys - move selection
- Enter or Tab - select current item
- Escape - dismiss popup
- Mouse click - select directly

**Connection lifecycle:**
- `onConnected()` called when WebSocket opens
- Triggers file list fetch (lazy, on-demand)
- Subsequent `@` uses cached list
- RPC response updates fileList and re-renders

### 3. **public/style.css** - Autocomplete styling

**New styles:**

```css
#file-autocomplete              /* Main popup container */
#file-autocomplete.visible      /* Show/hide toggle */
.file-autocomplete-item         /* Individual file item */
.file-autocomplete-item.focused /* Highlight (hover/keyboard) */
.file-autocomplete-item-match   /* Matched character highlighting */
```

**Styling details:**
- Dark theme colors (--accent border, --surface background)
- Max-height: 200px with scrollbar
- Positioned fixed above input
- Responsive width (12px left/right margin)
- Touch-friendly tap targets
- Smooth hover/focus transitions

### 4. **public/index.html** - HTML structure

**Added:**
```html
<!-- File reference autocomplete (shown near input) -->
<div id="file-autocomplete"></div>
```

Placed before the slash command picker for Z-index layering.

### 5. **AUTOCOMPLETE.md** - User documentation

Complete guide including:
- Feature overview
- Usage examples
- Implementation details
- Performance notes
- Customization options

## Architecture

```
Phone/Browser (Safari)
        ↓
    client.js
        ├─ Input event listener (detects @)
        ├─ Fuzzy scoring (client-side)
        ├─ UI rendering
        └─ RPC request: { type: "list_files" }
        ↓
   bridge.ts (Bun)
        ├─ Cache management (5s TTL)
        ├─ File system scan (recursive DFS)
        ├─ Ignore patterns
        └─ RPC response: { files: [...] }
        ↓
    Laptop Filesystem
```

## Performance

- **Lazy loading**: Files scanned only on first `@` keypress
- **Caching**: 5-second TTL prevents excessive filesystem access
- **Client-side scoring**: Fuzzy matching done in browser (fast)
- **Limited results**: Only top 15 matches shown (efficient rendering)
- **Incremental updates**: As user types, filters existing list (no network round-trips)

## Testing Checklist

- [x] Syntax validation (no parse errors)
- [x] Bridge file listing function
- [x] RPC request/response handling
- [x] Fuzzy matching algorithm
- [x] Keyboard navigation (↑↓ Enter Escape)
- [x] Mouse click selection
- [x] File insertion into input
- [x] Cursor positioning
- [x] Autocomplete dismissal
- [x] Styling and positioning
- [x] Dark theme colors
- [x] Mobile responsiveness

## Usage Example

1. Open web UI in Safari
2. Type: `Fix the bug in @src`
   - Popup shows: `src/main.ts`, `src/index.ts`, etc.
3. Press ↓ to select `src/main.ts`
4. Press Enter to insert
5. Result: `Fix the bug in @src/main.ts`

## Edge Cases Handled

- Multiple `@` characters → Last one before cursor used
- Whitespace stops search → No cross-word matches
- Empty query → Shows first 15 files
- Special characters → Ignored (only alphanumeric + `./-_`)
- Directory names → Included for path traversal
- Cursor repositioning → Maintains proper offset after selection
- Rapid connections/disconnections → Graceful handling
- Concurrent client file list updates → Each client independent

## Future Enhancements

Possible additions (not implemented):
- Fuzzy history in `~/.pi/agent/` to find past files
- File type icons or filtering (only `.ts`, etc.)
- Preview of file content on hover (size, lines)
- Keyboard shortcut to force-refresh file list
- Settings to customize ignore patterns
- Auto-expand directories (show contents with `@dir/`)
