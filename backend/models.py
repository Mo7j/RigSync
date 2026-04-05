from sqlalchemy import (
    JSON,
    Boolean,
    Float,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from database import Base


class TruckSpec(Base):
    __tablename__ = "truck_specs"

    type: Mapped[str] = mapped_column(String, primary_key=True)
    max_weight_tons: Mapped[float] = mapped_column(Float, nullable=False, default=0)
    max_length_m: Mapped[float] = mapped_column(Float, nullable=False, default=0)
    max_width_m: Mapped[float] = mapped_column(Float, nullable=False, default=0)
    max_height_m: Mapped[float] = mapped_column(Float, nullable=False, default=0)
    average_speed_kmh: Mapped[float] = mapped_column(Float, nullable=False, default=0)
    alpha: Mapped[float] = mapped_column(Float, nullable=False, default=0.3)

    compatible_loads: Mapped[list["LoadAllowedTruckType"]] = relationship(
        "LoadAllowedTruckType",
        back_populates="truck_spec",
        cascade="all, delete-orphan",
    )


class LoadTemplate(Base):
    __tablename__ = "load_templates"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    code: Mapped[str] = mapped_column(String, nullable=False, unique=True, index=True)
    source_kind: Mapped[str] = mapped_column(String, nullable=False, index=True)
    load_type: Mapped[str | None] = mapped_column(String, nullable=True)
    description: Mapped[str | None] = mapped_column(String, nullable=True)
    category: Mapped[str | None] = mapped_column(String, nullable=True)
    load_count: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    weight_tons: Mapped[float | None] = mapped_column(Float, nullable=True)
    weight_text: Mapped[str | None] = mapped_column(String, nullable=True)
    length_m: Mapped[float | None] = mapped_column(Float, nullable=True)
    width_m: Mapped[float | None] = mapped_column(Float, nullable=True)
    height_m: Mapped[float | None] = mapped_column(Float, nullable=True)
    dimensions_text: Mapped[str | None] = mapped_column(String, nullable=True)
    priority: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    avg_rig_down_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    avg_rig_up_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    optimal_rig_down_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    optimal_rig_up_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    is_critical: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    minimum_crew_down_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    minimum_crew_up_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    optimal_crew_down_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    optimal_crew_up_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    dependency_label: Mapped[str | None] = mapped_column(String, nullable=True)
    is_reusable: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    allowed_truck_types: Mapped[list["LoadAllowedTruckType"]] = relationship(
        "LoadAllowedTruckType",
        back_populates="load_template",
        cascade="all, delete-orphan",
        foreign_keys="LoadAllowedTruckType.load_template_id",
    )
    dependencies: Mapped[list["LoadDependency"]] = relationship(
        "LoadDependency",
        back_populates="load_template",
        cascade="all, delete-orphan",
        foreign_keys="LoadDependency.load_template_id",
    )
    role_requirements: Mapped[list["LoadRoleRequirement"]] = relationship(
        "LoadRoleRequirement",
        back_populates="load_template",
        cascade="all, delete-orphan",
        foreign_keys="LoadRoleRequirement.load_template_id",
    )


class LoadAllowedTruckType(Base):
    __tablename__ = "load_allowed_truck_types"
    __table_args__ = (
        UniqueConstraint("load_template_id", "truck_type", name="uq_load_allowed_truck_type"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    load_template_id: Mapped[int] = mapped_column(ForeignKey("load_templates.id"), nullable=False, index=True)
    truck_type: Mapped[str] = mapped_column(ForeignKey("truck_specs.type"), nullable=False, index=True)

    load_template: Mapped[LoadTemplate] = relationship(
        "LoadTemplate",
        back_populates="allowed_truck_types",
        foreign_keys=[load_template_id],
    )
    truck_spec: Mapped[TruckSpec] = relationship(
        "TruckSpec",
        back_populates="compatible_loads",
        foreign_keys=[truck_type],
    )


class LoadDependency(Base):
    __tablename__ = "load_dependencies"
    __table_args__ = (
        UniqueConstraint(
            "load_template_id",
            "depends_on_load_template_id",
            "dependency_phase",
            name="uq_load_dependency_phase",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    load_template_id: Mapped[int] = mapped_column(ForeignKey("load_templates.id"), nullable=False, index=True)
    depends_on_load_template_id: Mapped[int] = mapped_column(
        ForeignKey("load_templates.id"),
        nullable=False,
        index=True,
    )
    dependency_phase: Mapped[str] = mapped_column(String, nullable=False, default="general")

    load_template: Mapped[LoadTemplate] = relationship(
        "LoadTemplate",
        back_populates="dependencies",
        foreign_keys=[load_template_id],
    )
    depends_on_load_template: Mapped[LoadTemplate] = relationship(
        "LoadTemplate",
        foreign_keys=[depends_on_load_template_id],
    )


class LoadRoleRequirement(Base):
    __tablename__ = "load_role_requirements"
    __table_args__ = (
        UniqueConstraint(
            "load_template_id",
            "phase",
            "role_id",
            "requirement_kind",
            name="uq_load_role_requirement",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    load_template_id: Mapped[int] = mapped_column(ForeignKey("load_templates.id"), nullable=False, index=True)
    phase: Mapped[str] = mapped_column(String, nullable=False, index=True)
    role_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    requirement_kind: Mapped[str] = mapped_column(String, nullable=False, index=True)
    required_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    load_template: Mapped[LoadTemplate] = relationship(
        "LoadTemplate",
        back_populates="role_requirements",
        foreign_keys=[load_template_id],
    )


class MoveRecord(Base):
    __tablename__ = "move_records"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    manager_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    created_by_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    summary_payload: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    payload: Mapped[dict] = mapped_column(JSON, nullable=False)


class ManagerResourceState(Base):
    __tablename__ = "manager_resource_states"

    manager_id: Mapped[str] = mapped_column(String, primary_key=True)
    fleet: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    trucks: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    drivers: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    task_assignments: Mapped[list] = mapped_column(JSON, nullable=False, default=list)


class RigInventoryState(Base):
    __tablename__ = "rig_inventory_states"

    rig_id: Mapped[str] = mapped_column(String, primary_key=True)
    adjustments: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
