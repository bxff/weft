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
saved editable layer and the current tablet pages. It verifies checkpoint and
asset hashes before the upload. Use HTTPS outside localhost.

This first version does not restore PDF/EPUB documents, custom templates, folder
hierarchy, old edit history, notebooks without a complete checkpoint, or
requests over 16 MiB including encoding overhead. A missing or changed asset fails the preflight unless the checkpoint has a
verified fallback copy. Restore starts at the library root and retains live page
order. Inspect the notebook on the destination before linking a tablet normally.
