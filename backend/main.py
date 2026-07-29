from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from .config import get_allowed_origins
from .routes import router

app = FastAPI(title="LC Rating Predictor Proxy")

origins = get_allowed_origins()

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)

@app.get("/health")
def health():
    return {"status": "ok"}
