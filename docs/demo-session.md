# Demo Session (Live Local Instance)

Captured from a live local `scout-api` instance started with:

```bash
python3 -m uvicorn scout-api.main:app --host 127.0.0.1 --port 8420
```

Terminal output:

```bash
$ curl http://localhost:8420/health
{"status":"ok","db_path":"~/.pf-scout/contacts.db","contact_count":-1,"version":"0.1.0"}

$ curl -X POST http://localhost:8420/search -H "Content-Type: application/json" -d '{"query": "typescript"}'
{"results":[],"total":0,"query":"typescript"}

$ curl http://localhost:8420/profile/test_user
{"detail":"Contact not found: test_user"}
```
