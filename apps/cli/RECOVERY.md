# Restore one notebook from the tablet

This command restores a current-format, blank-template notebook into an empty
Weft relay account. It takes local copies, does not contact the old relay,
and does not change the tablet or its pairing.

Prepare stable local copies of the tablet's native notebook files and the
matching Weft recovery namespace. For `--native-dir`, use the directory with
the notebook's `<notebook-id>.metadata`, `<notebook-id>.content`, and
`<notebook-id>/` page and resource files. For `--recovery-dir`, use the
directory immediately above `<notebook-id>/` within the tablet's
`/home/root/weft/recovery-v1/` storage. Copy the namespace that belongs to
the account holding that notebook. Do not copy the tablet's credentials.

```sh
weft restore-notebook --dry-run --cloud https://your-new-relay \
  --notebook <notebook-uuid> --native-dir ./native --recovery-dir ./recovery
```

After checking the result, provide an API key from the new, empty destination
account through `WEFT_RESTORE_API_KEY` and run the same command without
`--dry-run`. The command sends the selected notebook in one request, with the
saved native pages and their matching editable layers and images. It verifies
checkpoint and asset hashes before upload. The selected notebook name and page
order come from your copied native catalog, but its loose page files are not
used by default. Use HTTPS outside localhost.

Add `--include-newer-native` only when the copied native files are from the
**same tablet and notebook, after those checkpoints were applied**, and were
copied while quiescent. Never use another tablet's files, an older backup, or
files copied mid-sync. The checkpoint cannot prove how a loose native page
was created; a missing stroke may mean Undo in a newer copy but not in an older
one. This mode is for newer native edits that do not need new or changed
images. If an image has changed or is missing, run without the flag to recover
the checkpoint and its known assets, not the newer edits. Local dry-run checks
the copied files and hashes; the relay checks native image references before
writing anything.

This first version does not restore PDF/EPUB documents, custom templates, folder
hierarchy, old edit history, notebooks without a complete checkpoint, or
requests over 16 MiB including encoding overhead. An image missing from its
normal location can be recovered in checkpoint-only mode if the checkpoint
has a verified fallback copy. Restore starts at the library root and retains live page
order. Inspect the notebook on the destination before linking a tablet normally.
