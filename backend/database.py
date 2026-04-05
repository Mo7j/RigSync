import os
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")
LOCAL_DATABASE_PATH = PROJECT_ROOT / "backend" / "rigsync_local.db"

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL or str(DATABASE_URL).strip().lower() == "local":
    DATABASE_URL = f"sqlite:///{LOCAL_DATABASE_PATH.as_posix()}"

if DATABASE_URL.startswith("postgresql://"):
    DATABASE_URL = DATABASE_URL.replace("postgresql://", "postgresql+psycopg://", 1)
ENGINE_KWARGS = {"future": True}

if DATABASE_URL.startswith("sqlite"):
    ENGINE_KWARGS["connect_args"] = {"check_same_thread": False}
else:
    ENGINE_KWARGS.update(
        {
            "pool_pre_ping": True,
            "pool_recycle": 1800,
            "pool_timeout": 10,
            "connect_args": {
                "connect_timeout": 5,
            },
        }
    )

engine = create_engine(DATABASE_URL, **ENGINE_KWARGS)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
Base = declarative_base()
