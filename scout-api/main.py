from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .routes import health, search, profile, list_contacts

app = FastAPI(
    title="pf-scout API",
    description="Contact intelligence API for the pf-scout-bot",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(search.router, prefix="/search", tags=["search"])
app.include_router(profile.router, prefix="/profile", tags=["profile"])
app.include_router(list_contacts.router, prefix="/list", tags=["list"])

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=settings.host, port=settings.port)
