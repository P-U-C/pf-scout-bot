from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    host: str = "127.0.0.1"
    port: int = 8420
    pf_scout_db: str = "~/.pf-scout/contacts.db"
    pf_jwt_token: str = ""
    github_token: str = ""
    log_level: str = "info"

    model_config = {"env_file": ".env", "env_prefix": "PF_SCOUT_"}


settings = Settings()
