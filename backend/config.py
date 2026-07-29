import os
from typing import List

def get_allowed_origins() -> List[str]:
    origins_str = os.getenv("ALLOWED_ORIGINS", "http://localhost:3000,chrome-extension://*,http://127.0.0.1:8000")
    return [o.strip() for o in origins_str.split(",") if o.strip()]
