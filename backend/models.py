from sqlalchemy import Boolean, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from database import Base


class LoadTemplate(Base):
    __tablename__ = "load_templates"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    phase: Mapped[str | None] = mapped_column(String, nullable=True)
    category: Mapped[str | None] = mapped_column(String, nullable=True)
    description: Mapped[str | None] = mapped_column(String, nullable=True)
    priority: Mapped[str | None] = mapped_column(String, nullable=True)
    truck_type: Mapped[str | None] = mapped_column(String, nullable=True)
    avg_duration_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    is_critical: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    floor_men: Mapped[int | None] = mapped_column(Integer, nullable=True)
    roustabouts: Mapped[int | None] = mapped_column(Integer, nullable=True)
    electricians: Mapped[int | None] = mapped_column(Integer, nullable=True)
    mechanics: Mapped[int | None] = mapped_column(Integer, nullable=True)
    welders: Mapped[int | None] = mapped_column(Integer, nullable=True)

    dependencies: Mapped[list["LoadDependency"]] = relationship(
        "LoadDependency",
        back_populates="load",
        cascade="all, delete-orphan",
        foreign_keys="LoadDependency.load_id",
    )


class LoadDependency(Base):
    __tablename__ = "load_dependencies"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    load_id: Mapped[int] = mapped_column(ForeignKey("load_templates.id"), nullable=False)
    depends_on_load_id: Mapped[int] = mapped_column(
        ForeignKey("load_templates.id"), nullable=False
    )

    load: Mapped[LoadTemplate] = relationship(
        "LoadTemplate",
        back_populates="dependencies",
        foreign_keys=[load_id],
    )
