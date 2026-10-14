"""Request shape for POST /v1/score."""
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator

ID_PATTERN = r"^(amazon|ebay):[A-Za-z0-9]{1,20}$"


class OriginalIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["png", "url"]
    dataBase64: Optional[str] = Field(default=None, max_length=4_000_000)
    url: Optional[str] = Field(default=None, max_length=2048)

    @model_validator(mode="after")
    def one_source(self):
        if self.kind == "png" and not self.dataBase64:
            raise ValueError("png needs dataBase64")
        if self.kind == "url" and not self.url:
            raise ValueError("url needs url")
        return self


class CandidateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=ID_PATTERN)
    url: str = Field(max_length=2048)


class OptionsIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    includeDiagnostics: bool = True


class ScoreIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    original: OriginalIn
    candidates: list[CandidateIn] = Field(min_length=1)
    options: OptionsIn = OptionsIn()
