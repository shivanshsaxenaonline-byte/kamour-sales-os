# Prototype interaction checks

Executed in Happy DOM against the actual HTML, CSS and JavaScript. These are DOM/event checks, not real-browser rendering or accessibility certification.

- PASS: Initial grid has 50 synthetic records, correct initial sort, and both theme swatch sheets
- PASS: Theme toggles and resolves distinct CSS variables
- PASS: Keyboard J/K, Space, bulk bar and Escape work
- PASS: Search, empty state and saved filter work
- PASS: Column visibility changes table structure
- PASS: Empty owner is rejected, then valid owner saves optimistically
- PASS: Failed save restores previous owner and Retry retains attempted value
- PASS: Expansion shows a local skeleton, then details; Escape closes
- PASS: Detail failure offers working inline Retry
- PASS: Soft lock disables selection and editing, but permits reading
- PASS: Live update stays in place even when it no longer matches Paid filter
- PASS: Claim reveals masked phone and assigns the record
- PASS: Bulk archive is reversible, with a visible 10-second timer
- PASS: Loading keeps the header and supplies exactly 20 skeleton rows
- PASS: Ctrl+K command search and navigation work
- PASS: CSS density contract and reduced-motion rule exist (not a layout measurement)

Browser connection returned no available browsers. Screenshot review, actual 1366 × 768 geometry, native dialog focus trapping and real keyboard/rendering behaviour remain unverified.
