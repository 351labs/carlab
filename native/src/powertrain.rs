//! Faithful f64 port of the lab's v4 reduced engine/powertrain model.
use crate::config::{EngineConfig, PhysicalAudioState};
use crate::cylinder_cycle::{
    CylinderCycleConfig, CylinderCycleResult, HeatTransferModel, PropertyModel, solve_cylinder_cycle,
};
use crate::ecu::{CombustionMode, Ecu, EcuConfig, EcuInput, EcuState, evaluate_ecu_steady};
use crate::gas_path::{
    GasPath, GasPathConfig, GasPathInput, GasPathReset, GasPathState, compressible_orifice_flow,
    exhaust_pressure_loss,
};
use crate::maps::{
    CalibrationKind, CalibrationMap, CalibrationProvenance, CalibrationValidation,
    create_assumed_ve_map, normalize_calibration_map, sample_calibration_map, valid_date,
};
use crate::materials::{MaterialScreenConfig, normalize_material_screen_config};
use crate::thermal::{
    ThermalConfig, ThermalLoads, ThermalNetwork, ThermalState, normalize_thermal_config,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{cell::RefCell, collections::VecDeque, sync::Arc};
const TAU: f64 = std::f64::consts::TAU;
const AIR_R: f64 = 287.05;
const G: f64 = 9.80665;
/// How the steady cycle obtains trapped air. `VeMapFit` (legacy) scales the
/// effective intake lift toward the declared VE map; `ValveGeometry` solves the
/// declared valve events/areas once and reports the resulting VE untargeted.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AirflowModel {
    #[default]
    VeMapFit,
    ValveGeometry,
}
fn choice<T: for<'de> Deserialize<'de> + Default>(v: &Value, key: &str) -> Result<T, String> {
    match v.get(key) {
        None | Some(Value::Null) => Ok(T::default()),
        Some(x) => serde_json::from_value(x.clone()).map_err(|_| format!("Unsupported {key}: {x}")),
    }
}
fn one() -> f64 {
    1.0
}
fn generic_hc() -> f64 {
    1.85
}
fn clamp(value: f64, min: f64, max: f64) -> f64 {
    value.max(min).min(max)
}
fn bounded(value: f64, fallback: f64, min: f64, max: f64) -> f64 {
    if value.is_finite() {
        clamp(value, min, max)
    } else {
        fallback
    }
}
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}
fn number(v: &Value, key: &str, fallback: f64, min: f64, max: f64) -> f64 {
    bounded(
        v.get(key).and_then(Value::as_f64).unwrap_or(f64::NAN),
        fallback,
        min,
        max,
    )
}
fn text(v: &Value, key: &str, fallback: &str, limit: usize) -> String {
    v.get(key)
        .and_then(Value::as_str)
        .unwrap_or(fallback)
        .chars()
        .take(limit)
        .collect()
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhysicalConfig {
    pub bore_stroke_ratio: f64,
    pub rod_length_stroke_ratio: f64,
    pub reciprocating_mass_kg: f64,
    pub ambient_pressure_bar: f64,
    pub intake_temperature_k: f64,
    pub volumetric_efficiency: f64,
    pub combustion_efficiency: f64,
    pub thermal_utilization: f64,
    pub gamma: f64,
    #[serde(rename = "fuelLhvMJkg")]
    pub fuel_lhv_mjkg: f64,
    pub air_fuel_ratio: f64,
    pub friction_base_bar: f64,
    pub friction_speed_bar: f64,
    pub engine_inertia_kg_m2: f64,
    pub vehicle_mass_kg: f64,
    pub tyre_radius_m: f64,
    pub final_drive: f64,
    pub gear_ratios: Vec<f64>,
    pub drive_efficiency: f64,
    pub drag_cd_a: f64,
    pub rolling_resistance: f64,
    pub grade_percent: f64,
    pub assumed_peak_pressure_bar: f64,
    pub assumed_mean_piston_speed_ms: f64,
    pub intake_volume_l: f64,
    pub exhaust_volume_l: f64,
    pub throttle_diameter_mm: f64,
    pub throttle_discharge: f64,
    pub throttle_leak_fraction: f64,
    pub exhaust_restriction_k: f64,
    pub exhaust_friction_factor: f64,
    pub compressor_efficiency: f64,
    pub turbine_efficiency: f64,
    pub turbine_restriction_k: f64,
    pub intercooler_effectiveness: f64,
    pub turbo_inertia_kg_m2: f64,
    pub spark_advance_deg: f64,
    pub burn_duration_deg: f64,
    pub wiebe_shape: f64,
    pub wiebe_efficiency: f64,
    pub intake_open_deg: f64,
    pub intake_close_deg: f64,
    pub exhaust_open_deg: f64,
    pub exhaust_close_deg: f64,
    pub intake_valve_diameter_mm: f64,
    pub exhaust_valve_diameter_mm: f64,
    pub intake_valve_lift_mm: f64,
    pub exhaust_valve_lift_mm: f64,
    pub intake_valve_count: f64,
    pub exhaust_valve_count: f64,
    pub valve_discharge_coefficient: f64,
    pub wall_temperature_k: f64,
    pub heat_transfer_wm2_k: f64,
    pub variable_heat_capacity: bool,
    // Model-3 options; serde defaults keep model-2 JSON meaning.
    #[serde(default)]
    pub property_model: PropertyModel,
    #[serde(default = "generic_hc")]
    pub fuel_hydrogen_carbon_ratio: f64,
    #[serde(default)]
    pub fuel_oxygen_carbon_ratio: f64,
    #[serde(default)]
    pub heat_transfer_model: HeatTransferModel,
    #[serde(default = "one")]
    pub heat_transfer_multiplier: f64,
    #[serde(default)]
    pub spark_to_soc_deg: f64,
    /// Cam phaser shift applied to both opening and closing (positive = later).
    #[serde(default)]
    pub intake_cam_retard_deg: f64,
    #[serde(default)]
    pub exhaust_cam_retard_deg: f64,
    #[serde(default)]
    pub airflow_model: AirflowModel,
    pub cycle_variability: f64,
    pub ecu: EcuConfig,
    pub ve_map: CalibrationMap,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fmep_map: Option<CalibrationMap>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indicated_efficiency_map: Option<CalibrationMap>,
    pub provenance: CalibrationProvenance,
    pub thermal: ThermalConfig,
    pub material_screen: MaterialScreenConfig,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cycle_calibration: Option<PressureCalibration>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineGeometry {
    pub displacement_m3: f64,
    pub cylinder_displacement_m3: f64,
    pub bore_mm: f64,
    pub stroke_mm: f64,
    pub rod_length_mm: f64,
    pub piston_area_m2: f64,
    pub clearance_volume_m3: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineEstimate {
    pub rpm: f64,
    pub throttle: f64,
    pub torque_nm: f64,
    pub power_kw: f64,
    pub power_hp: f64,
    pub indicated_torque_nm: f64,
    pub friction_torque_nm: f64,
    pub pumping_torque_nm: f64,
    pub bmep_bar: f64,
    pub fmep_bar: f64,
    pub manifold_pressure_bar: f64,
    pub ivc_pressure_bar: f64,
    /// Fresh air retained at IVC (not an airbox meter observable).
    pub air_mass_flow_kgs: f64,
    /// Signed net intake-valve flow, comparable with a steady inlet air meter.
    #[serde(default)]
    pub net_inlet_air_mass_flow_kgs: f64,
    pub fuel_mass_flow_kgs: f64,
    pub fuel_power_kw: f64,
    pub brake_efficiency: f64,
    pub otto_efficiency: f64,
    pub compression_pressure_bar: f64,
    pub compression_temperature_k: f64,
    pub ideal_peak_pressure_bar: f64,
    pub ideal_peak_gas_temperature_k: f64,
    pub mean_piston_speed_ms: f64,
    pub ideal_gas_force_n: f64,
    pub inertia_force_tdc_n: f64,
    pub fuel_cut: bool,
    pub screen_flags: Vec<String>,
    pub geometry: EngineGeometry,
    pub exhaust_pressure_bar: f64,
    pub exhaust_temperature_k: f64,
    pub mapped_volumetric_efficiency: f64,
    pub actual_volumetric_efficiency: f64,
    pub ve_target_residual: f64,
    pub map_extrapolated: bool,
    pub calibration_source: String,
    pub wall_heat_loss_w: f64,
    pub cycle: CycleSummary,
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ecu: Option<EcuCouplingSummary>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PowertrainState {
    pub rpm: f64,
    pub load: f64,
    pub throttle: f64,
    pub speed_ms: f64,
    pub speed_kmh: f64,
    pub acceleration_ms2: f64,
    pub gear: f64,
    pub clutch: f64,
    pub torque_nm: f64,
    pub power_kw: f64,
    pub resistance_n: f64,
    pub traction_n: f64,
    pub boost_fraction: f64,
    pub quantitatively_valid: bool,
    pub physical: PhysicalAudioState,
    pub physical_audio: PhysicalAudioState,
    pub thermal: ThermalState,
    pub gas_path: GasPathState,
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ecu: Option<EcuState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ecu_coupling: Option<EcuCouplingSummary>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PressureCalibration {
    pub source: String,
    pub reference_hash: String,
    pub rpm: f64,
    pub throttle: f64,
    pub rmse_bar: f64,
    pub method: String,
    pub status: String,
    pub spark_advance_deg: f64,
    pub burn_duration_deg: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub angle_origin: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CycleSummary {
    pub net_work_j: f64,
    pub gross_work_j: f64,
    pub pumping_work_j: f64,
    pub peak_pressure_pa: f64,
    pub peak_temperature_k: f64,
    pub peak_pressure_rise_pa_per_deg: f64,
    pub mass_balance_residual_kg: f64,
    pub energy_balance_residual_j: f64,
    pub periodic_mass_relative_error: f64,
    pub periodic_energy_relative_error: f64,
    pub ca50_deg: f64,
    pub residual_fraction: f64,
    pub lookup_rpm: f64,
    pub lookup_intake_pressure_bar: f64,
    // Model-3 diagnostics (all per cylinder per 720 degrees unless stated).
    #[serde(default)]
    pub soc_deg: f64,
    #[serde(default)]
    pub ca10_deg: f64,
    #[serde(default)]
    pub ca90_deg: f64,
    /// IVO, IVC, EVO, EVC actually solved (cycle degrees, after cam shifts).
    #[serde(default)]
    pub valve_events_deg: [f64; 4],
    /// Fresh air at IVC, gross intake-valve inflow and reverse flow.
    #[serde(default)]
    pub trapped_fresh_mass_kg: f64,
    #[serde(default)]
    pub intake_in_mass_kg: f64,
    #[serde(default)]
    pub intake_reverse_mass_kg: f64,
    #[serde(default)]
    pub wall_heat_loss_j: f64,
    #[serde(default)]
    pub peak_heat_transfer_wm2_k: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GasPathBoundary {
    pub intake_pressure_pa: f64,
    pub intake_temperature_k: f64,
    pub exhaust_pressure_pa: f64,
    pub exhaust_temperature_k: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CycleCalibration {
    #[serde(rename = "mappedVE")]
    pub mapped_ve: f64,
    #[serde(rename = "actualVE")]
    pub actual_ve: f64,
    pub ve_residual: f64,
    pub extrapolated: bool,
    pub effective_intake_lift_m: f64,
    pub iterations: usize,
    #[serde(default)]
    pub airflow_model: AirflowModel,
    /// Every inverse-area solve, so a missed target can be classified from evidence.
    #[serde(default)]
    pub trials: Vec<VeTrial>,
    /// `lift-bound`, `step-ratio-limit`, `sub-proportional-lift-response` or `unproven`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub miss_classification: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indicated_efficiency_target: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indicated_efficiency_residual: Option<f64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VeTrial {
    pub lift_m: f64,
    #[serde(rename = "actualVE")]
    pub actual_ve: f64,
    /// Fraction of the open event where curtain area is capped by seat area.
    pub seat_capped_fraction: f64,
    pub step_ratio_clamped: bool,
    pub lift_bound_hit: bool,
}
fn seat_capped_fraction(lift_m: f64, diameter_m: f64) -> f64 {
    // pi*D*L*sin^2 >= pi*D^2/4 where sin^2 >= D/(4L).
    let k = diameter_m / (4.0 * lift_m);
    if k >= 1.0 { 0.0 } else { 1.0 - 2.0 * k.sqrt().asin() / std::f64::consts::PI }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CalibratedCylinderCycle {
    #[serde(flatten)]
    pub result: CylinderCycleResult,
    pub calibration: CycleCalibration,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ecu: Option<EcuCouplingSummary>,
}
impl std::ops::Deref for CalibratedCylinderCycle {
    type Target = CylinderCycleResult;
    fn deref(&self) -> &Self::Target {
        &self.result
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PotentialEnvelope {
    pub points: Vec<EngineEstimate>,
    pub peak_power: EngineEstimate,
    pub peak_torque: EngineEstimate,
    pub screened_peak_power: Option<EngineEstimate>,
    pub limiting_causes: Vec<String>,
    pub status: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EcuCouplingSummary {
    #[serde(flatten)]
    pub state: EcuState,
    pub coupling_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plant_lambda: Option<f64>,
    pub cycle_released_heat_j: f64,
    pub cycle_fuel_energy_j: f64,
    pub cycle_fuel_mass_kg: f64,
    pub demanded_cycle_fuel_mass_kg: f64,
    pub fuel_mass_relative_mismatch: f64,
    pub fresh_air_mass_flow_kgs: f64,
    pub combustion_energy_scale: f64,
    pub oxygen_limited: bool,
    pub coupling_quantitatively_valid: bool,
    pub coupling_flags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub injection_pressure_reference_pa: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cycle_injection_pressure_pa: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub injection_pressure_relative_mismatch: Option<f64>,
}
impl PhysicalConfig {
    pub fn default_for(engine: &EngineConfig) -> Self {
        Self::from_value(engine, &Value::Null).expect("valid original defaults")
    }
    pub fn from_value(e: &EngineConfig, v: &Value) -> Result<Self, String> {
        let thermal = normalize_thermal_config(&v["thermal"]);
        let bore_stroke_ratio = number(v, "boreStrokeRatio", 1.05, 0.5, 2.0);
        let rod_length_stroke_ratio = number(v, "rodLengthStrokeRatio", 1.7, 1.3, 2.5);
        let stroke = (4.0 * (e.displacement * 0.001 / e.cylinders as f64)
            / (std::f64::consts::PI * bore_stroke_ratio.powi(2)))
        .cbrt();
        let bore_mm = stroke * bore_stroke_ratio * 1000.0;
        let gear_ratios = v["gearRatios"]
            .as_array()
            .filter(|a| {
                !a.is_empty()
                    && a.len() <= 8
                    && a.iter().all(|x| {
                        x.as_f64()
                            .is_some_and(|n| n.is_finite() && (0.3..=6.0).contains(&n))
                    })
            })
            .map(|a| a.iter().map(|x| x.as_f64().unwrap()).collect())
            .unwrap_or_else(|| vec![3.5, 2.15, 1.48, 1.13, 0.91, 0.76]);
        let volumetric_efficiency = number(v, "volumetricEfficiency", 0.9, 0.3, 1.25);
        let ve_map = if v.get("veMap").is_some() {
            normalize_calibration_map(&v["veMap"], CalibrationKind::Ve)?
        } else {
            create_assumed_ve_map(e.idle_rpm, e.redline, volumetric_efficiency, false)?
        };
        let fmep_map = if v.get("fmepMap").is_some_and(truthy) {
            Some(normalize_calibration_map(
                &v["fmepMap"],
                CalibrationKind::Fmep,
            )?)
        } else {
            None
        };
        let indicated_efficiency_map = if v.get("indicatedEfficiencyMap").is_some_and(truthy) {
            Some(normalize_calibration_map(
                &v["indicatedEfficiencyMap"],
                CalibrationKind::IndicatedEfficiency,
            )?)
        } else {
            None
        };
        let source = &v["provenance"];
        let provenance = CalibrationProvenance {
            source: source["source"]
                .as_str()
                .filter(|s| *s == "measured" || *s == "fitted")
                .unwrap_or("assumed")
                .into(),
            label: text(source, "label", "Original exploratory assumptions", 160),
            version: text(source, "version", "physical-2", 60),
            engine_id: source["engineId"]
                .as_str()
                .map(|_| text(source, "engineId", "", 120)),
            notes: source["notes"]
                .as_str()
                .map(|_| text(source, "notes", "", 2000)),
            calibrated_at: source["calibratedAt"]
                .as_str()
                .filter(|s| valid_date(s))
                .map(String::from),
            validation: if source["validation"]["label"].is_string()
                && source["validation"]["independent"].is_boolean()
            {
                Some(CalibrationValidation {
                    label: text(&source["validation"], "label", "", 200),
                    independent: source["validation"]["independent"].as_bool().unwrap(),
                    date: source["validation"]["date"]
                        .as_str()
                        .filter(|s| valid_date(s))
                        .map(String::from),
                })
            } else {
                None
            },
        };
        let c = &v["cycleCalibration"];
        let cycle_calibration = if c["method"] == "bounded-grid" && c["status"] == "fitted" {
            Some(PressureCalibration {
                source: text(c, "source", "", 200),
                reference_hash: text(c, "referenceHash", "", 200),
                rpm: number(c, "rpm", 3000.0, 300.0, 18000.0),
                throttle: number(c, "throttle", 1.0, 0.0, 1.0),
                rmse_bar: number(c, "rmseBar", 0.0, 0.0, 1000.0),
                method: "bounded-grid".into(),
                status: "fitted".into(),
                spark_advance_deg: number(c, "sparkAdvanceDeg", 18.0, -10.0, 50.0),
                burn_duration_deg: number(c, "burnDurationDeg", 50.0, 15.0, 120.0),
                angle_origin: c["angleOrigin"]
                    .as_str()
                    .filter(|s| *s == "intake-tdc" || *s == "firing-tdc")
                    .map(String::from),
            })
        } else {
            None
        };
        Ok(Self {
            bore_stroke_ratio,
            rod_length_stroke_ratio,
            gear_ratios,
            volumetric_efficiency,
            ve_map,
            fmep_map,
            indicated_efficiency_map,
            provenance,
            reciprocating_mass_kg: number(v, "reciprocatingMassKg", 0.45, 0.08, 2.0),
            ambient_pressure_bar: number(v, "ambientPressureBar", 1.01325, 0.5, 1.2),
            intake_temperature_k: number(v, "intakeTemperatureK", 315.0, 240.0, 450.0),
            combustion_efficiency: number(v, "combustionEfficiency", 0.96, 0.5, 1.0),
            thermal_utilization: number(v, "thermalUtilization", 0.72, 0.2, 1.0),
            gamma: number(v, "gamma", 1.33, 1.15, 1.4),
            fuel_lhv_mjkg: number(v, "fuelLhvMJkg", 43.0, 20.0, 50.0),
            air_fuel_ratio: number(v, "airFuelRatio", 14.7, 8.0, 22.0),
            friction_base_bar: number(v, "frictionBaseBar", 0.65, 0.0, 3.0),
            friction_speed_bar: number(v, "frictionSpeedBar", 0.045, 0.0, 0.2),
            engine_inertia_kg_m2: number(
                v,
                "engineInertiaKgM2",
                0.08 + e.inertia * 0.45,
                0.03,
                2.0,
            ),
            vehicle_mass_kg: number(
                v,
                "vehicleMassKg",
                1100.0 + e.displacement * 80.0,
                400.0,
                3500.0,
            ),
            tyre_radius_m: number(v, "tyreRadiusM", 0.315, 0.2, 0.5),
            final_drive: number(v, "finalDrive", 3.9, 2.0, 6.0),
            drive_efficiency: number(v, "driveEfficiency", 0.9, 0.65, 1.0),
            drag_cd_a: number(v, "dragCdA", 0.65, 0.2, 1.8),
            rolling_resistance: number(v, "rollingResistance", 0.013, 0.0, 0.04),
            grade_percent: number(v, "gradePercent", 0.0, -20.0, 20.0),
            assumed_peak_pressure_bar: number(v, "assumedPeakPressureBar", 150.0, 30.0, 350.0),
            assumed_mean_piston_speed_ms: number(v, "assumedMeanPistonSpeedMs", 23.0, 8.0, 40.0),
            intake_volume_l: number(
                v,
                "intakeVolumeL",
                1.0_f64.max(e.displacement * 1.2),
                0.2,
                30.0,
            ),
            exhaust_volume_l: number(
                v,
                "exhaustVolumeL",
                1.0_f64.max(e.displacement * 1.5),
                0.2,
                30.0,
            ),
            throttle_diameter_mm: number(
                v,
                "throttleDiameterMm",
                100.0_f64.min(35.0 + e.displacement * 8.0),
                5.0,
                150.0,
            ),
            throttle_discharge: number(v, "throttleDischarge", 0.72, 0.1, 1.0),
            throttle_leak_fraction: number(v, "throttleLeakFraction", 0.01, 0.001, 0.1),
            exhaust_restriction_k: number(v, "exhaustRestrictionK", 2.0, 0.0, 100.0),
            exhaust_friction_factor: number(v, "exhaustFrictionFactor", 0.025, 0.005, 0.12),
            compressor_efficiency: number(v, "compressorEfficiency", 0.7, 0.35, 0.9),
            turbine_efficiency: number(v, "turbineEfficiency", 0.65, 0.3, 0.9),
            turbine_restriction_k: number(
                v,
                "turbineRestrictionK",
                if e.boost_bar > 0.0 { 12.0 } else { 0.0 },
                0.0,
                100.0,
            ),
            intercooler_effectiveness: number(v, "intercoolerEffectiveness", 0.65, 0.0, 0.95),
            turbo_inertia_kg_m2: number(
                v,
                "turboInertiaKgM2",
                0.00002 + e.turbo_size * 0.00008,
                0.000005,
                0.001,
            ),
            spark_advance_deg: number(v, "sparkAdvanceDeg", 18.0, -10.0, 50.0),
            burn_duration_deg: number(v, "burnDurationDeg", 50.0, 15.0, 120.0),
            wiebe_shape: number(v, "wiebeShape", 2.0, 0.5, 5.0),
            wiebe_efficiency: number(v, "wiebeEfficiency", 6.9, 2.0, 10.0),
            intake_open_deg: number(v, "intakeOpenDeg", 710.0, 650.0, 719.9),
            intake_close_deg: number(v, "intakeCloseDeg", 220.0, 140.0, 280.0),
            exhaust_open_deg: number(v, "exhaustOpenDeg", 500.0, 430.0, 590.0),
            exhaust_close_deg: number(v, "exhaustCloseDeg", 10.0, 0.0, 70.0),
            intake_valve_diameter_mm: number(v, "intakeValveDiameterMm", bore_mm * 0.36, 6.0, 90.0),
            exhaust_valve_diameter_mm: number(
                v,
                "exhaustValveDiameterMm",
                bore_mm * 0.32,
                6.0,
                90.0,
            ),
            intake_valve_lift_mm: number(v, "intakeValveLiftMm", bore_mm * 0.10, 0.5, 25.0),
            exhaust_valve_lift_mm: number(v, "exhaustValveLiftMm", bore_mm * 0.09, 0.5, 25.0),
            intake_valve_count: number(v, "intakeValveCount", 2.0, 1.0, 4.0).round(),
            exhaust_valve_count: number(v, "exhaustValveCount", 2.0, 1.0, 4.0).round(),
            valve_discharge_coefficient: number(v, "valveDischargeCoefficient", 0.68, 0.1, 1.0),
            wall_temperature_k: number(
                v,
                "wallTemperatureK",
                clamp(thermal.initial_wall_temperature_k, 230.0, 1000.0),
                230.0,
                1000.0,
            ),
            heat_transfer_wm2_k: number(v, "heatTransferWm2K", 180.0, 0.0, 3000.0),
            variable_heat_capacity: v["variableHeatCapacity"] == true,
            property_model: choice(v, "propertyModel")?,
            fuel_hydrogen_carbon_ratio: number(v, "fuelHydrogenCarbonRatio", 1.85, 0.5, 4.0),
            fuel_oxygen_carbon_ratio: number(v, "fuelOxygenCarbonRatio", 0.0, 0.0, 1.0),
            heat_transfer_model: choice(v, "heatTransferModel")?,
            heat_transfer_multiplier: number(v, "heatTransferMultiplier", 1.0, 0.0, 5.0),
            spark_to_soc_deg: number(v, "sparkToSocDeg", 0.0, -20.0, 60.0),
            intake_cam_retard_deg: number(v, "intakeCamRetardDeg", 0.0, -80.0, 80.0),
            exhaust_cam_retard_deg: number(v, "exhaustCamRetardDeg", 0.0, -80.0, 80.0),
            airflow_model: choice(v, "airflowModel")?,
            cycle_variability: number(v, "cycleVariability", e.roughness * 0.35, 0.0, 1.0),
            ecu: EcuConfig::from_value(e, &v["ecu"])?,
            thermal,
            material_screen: normalize_material_screen_config(&v["materialScreen"])?,
            cycle_calibration,
        })
    }
}
pub fn engine_geometry(e: &EngineConfig, p: &PhysicalConfig) -> EngineGeometry {
    let displacement_m3 = e.displacement * 0.001;
    let cylinder_displacement_m3 = displacement_m3 / e.cylinders as f64;
    let stroke = (4.0 * cylinder_displacement_m3
        / (std::f64::consts::PI * p.bore_stroke_ratio.powi(2)))
    .cbrt();
    let bore = stroke * p.bore_stroke_ratio;
    EngineGeometry {
        displacement_m3,
        cylinder_displacement_m3,
        bore_mm: bore * 1000.0,
        stroke_mm: stroke * 1000.0,
        rod_length_mm: stroke * p.rod_length_stroke_ratio * 1000.0,
        piston_area_m2: std::f64::consts::PI * bore * bore / 4.0,
        clearance_volume_m3: cylinder_displacement_m3 / (e.compression - 1.0),
    }
}
pub fn gas_path_config_for(e: &EngineConfig, p: &PhysicalConfig) -> GasPathConfig {
    GasPathConfig {
        ambient_pressure_pa: p.ambient_pressure_bar * 1e5,
        ambient_temperature_k: p.intake_temperature_k,
        intake_volume_m3: p.intake_volume_l * 0.001,
        exhaust_volume_m3: p.exhaust_volume_l * 0.001,
        throttle_diameter_m: p.throttle_diameter_mm * 0.001,
        throttle_discharge: p.throttle_discharge,
        throttle_leak_fraction: p.throttle_leak_fraction,
        exhaust_diameter_m: e.pipe_diameter * 0.001,
        exhaust_length_m: e.exhaust_length + e.header_length,
        exhaust_minor_k: p.exhaust_restriction_k
            + if e.boost_bar > 0.0 {
                p.turbine_restriction_k
            } else {
                0.0
            },
        exhaust_friction_factor: p.exhaust_friction_factor,
        gamma: p.gamma,
        gas_constant: AIR_R,
    }
}
fn compressor_boundary(e: &EngineConfig, p: &PhysicalConfig, boost: f64) -> (f64, f64) {
    let pressure = (p.ambient_pressure_bar + e.boost_bar * clamp(boost, 0.0, 1.0)) * 1e5;
    let ratio = pressure / (p.ambient_pressure_bar * 1e5);
    let rise = p.intake_temperature_k * (ratio.powf((p.gamma - 1.0) / p.gamma) - 1.0)
        / p.compressor_efficiency;
    (
        pressure,
        p.intake_temperature_k + rise * (1.0 - p.intercooler_effectiveness),
    )
}
fn steady_boundary(
    e: &EngineConfig,
    p: &PhysicalConfig,
    rpm: f64,
    throttle: f64,
    boost: f64,
) -> Result<GasPathBoundary, String> {
    let (up_p, up_t) = compressor_boundary(e, p, boost);
    let geometry = engine_geometry(e, p);
    let area = std::f64::consts::PI * (p.throttle_diameter_mm * 0.001).powi(2) / 4.0
        * (p.throttle_leak_fraction + (1.0 - p.throttle_leak_fraction) * throttle.powi(2));
    let (mut lo, mut hi) = (15000.0, up_p);
    for _ in 0..32 {
        let pressure = (lo + hi) / 2.0;
        let ve = sample_calibration_map(&p.ve_map, rpm, pressure / 1e5)?.value;
        let demand = pressure / (AIR_R * up_t) * geometry.displacement_m3 * ve * rpm / 120.0;
        let incoming = compressible_orifice_flow(
            up_p,
            up_t,
            pressure,
            up_t,
            area,
            p.throttle_discharge,
            p.gamma,
            AIR_R,
        )?;
        if incoming > demand {
            lo = pressure
        } else {
            hi = pressure
        }
    }
    let intake_pressure_pa = (lo + hi) / 2.0;
    let ve = sample_calibration_map(&p.ve_map, rpm, intake_pressure_pa / 1e5)?.value;
    let mass_flow =
        intake_pressure_pa / (AIR_R * up_t) * geometry.displacement_m3 * ve * rpm / 120.0;
    let exhaust_temperature_k = clamp(e.temperature + 273.15, 350.0, 1500.0);
    let ambient = p.ambient_pressure_bar * 1e5;
    let c = gas_path_config_for(e, p);
    let loss = exhaust_pressure_loss(
        mass_flow,
        ambient / (AIR_R * exhaust_temperature_k),
        c.exhaust_diameter_m,
        c.exhaust_length_m,
        c.exhaust_minor_k,
        c.exhaust_friction_factor,
    )?;
    let exhaust_pressure_pa = (ambient + (ambient * ambient + 4.0 * ambient * loss).sqrt()) / 2.0;
    Ok(GasPathBoundary {
        intake_pressure_pa,
        intake_temperature_k: up_t,
        exhaust_pressure_pa,
        exhaust_temperature_k,
    })
}
pub fn cycle_config_for(
    e: &EngineConfig,
    p: &PhysicalConfig,
    input_rpm: f64,
    input_throttle: f64,
    boundary_override: Option<&GasPathBoundary>,
    boost: f64,
) -> Result<CylinderCycleConfig, String> {
    let rpm = bounded(input_rpm, e.idle_rpm, 300.0, 18000.0);
    let throttle = bounded(input_throttle, 0.0, 0.0, 1.0);
    let g = engine_geometry(e, p);
    let boundary = match boundary_override {
        Some(b) => b.clone(),
        None => steady_boundary(e, p, rpm, air_throttle_for(p, throttle), boost)?,
    };
    CylinderCycleConfig {
        bore_m: g.bore_mm * 0.001,
        stroke_m: g.stroke_mm * 0.001,
        rod_length_m: g.rod_length_mm * 0.001,
        compression_ratio: e.compression,
        rpm,
        intake_pressure_pa: boundary.intake_pressure_pa,
        intake_temperature_k: boundary.intake_temperature_k,
        exhaust_pressure_pa: boundary.exhaust_pressure_pa,
        exhaust_temperature_k: boundary.exhaust_temperature_k,
        // TS maps a partial cylinder config: missing initial conditions default
        // to the normalized exhaust boundary, not standalone static defaults.
        initial_pressure_pa: bounded(boundary.exhaust_pressure_pa, 106000.0, 30000.0, 700000.0),
        initial_temperature_k: bounded(boundary.exhaust_temperature_k, 800.0, 240.0, 1800.0),
        intake_open_deg: p.intake_open_deg + p.intake_cam_retard_deg,
        intake_close_deg: p.intake_close_deg + p.intake_cam_retard_deg,
        exhaust_open_deg: p.exhaust_open_deg + p.exhaust_cam_retard_deg,
        exhaust_close_deg: p.exhaust_close_deg + p.exhaust_cam_retard_deg,
        intake_valve_diameter_m: p.intake_valve_diameter_mm * 0.001,
        exhaust_valve_diameter_m: p.exhaust_valve_diameter_mm * 0.001,
        intake_valve_lift_m: p.intake_valve_lift_mm * 0.001,
        exhaust_valve_lift_m: p.exhaust_valve_lift_mm * 0.001,
        intake_valve_count: p.intake_valve_count,
        exhaust_valve_count: p.exhaust_valve_count,
        discharge_coefficient: p.valve_discharge_coefficient,
        spark_advance_deg: if diesel_active(p) {
            0.0
        } else {
            p.spark_advance_deg
        },
        combustion_start_deg: if diesel_active(p) {
            Some(
                360.0
                    - p.ecu
                        .diesel
                        .injection_advance_map
                        .sample(rpm, boundary.intake_pressure_pa / 1e5)?
                        .value
                    + p.ecu.diesel.ignition_delay_deg,
            )
        } else {
            None
        },
        burn_duration_deg: if diesel_active(p) {
            p.ecu.diesel.burn_duration_deg
        } else {
            p.burn_duration_deg
        },
        wiebe_shape: p.wiebe_shape,
        wiebe_efficiency: p.wiebe_efficiency,
        air_fuel_ratio: p.air_fuel_ratio,
        fuel_lhv_jkg: p.fuel_lhv_mjkg * 1e6,
        combustion_efficiency: p.combustion_efficiency,
        wall_temperature_k: p.wall_temperature_k,
        heat_transfer_wm2_k: p.heat_transfer_wm2_k,
        gamma: p.gamma,
        variable_heat_capacity: p.variable_heat_capacity,
        property_model: p.property_model,
        fuel_hydrogen_carbon_ratio: p.fuel_hydrogen_carbon_ratio,
        fuel_oxygen_carbon_ratio: p.fuel_oxygen_carbon_ratio,
        heat_transfer_model: p.heat_transfer_model,
        heat_transfer_multiplier: p.heat_transfer_multiplier,
        // Diesel SOC stays SOI + ignition delay; the SI offset never applies there.
        spark_to_soc_deg: if diesel_active(p) { 0.0 } else { p.spark_to_soc_deg },
        step_deg: 2.0,
        settling_cycles: 3.0,
        fuel_mass_kg: if diesel_active(p) || throttle < 0.005 || input_rpm >= e.redline {
            Some(0.0)
        } else {
            None
        },
        ..CylinderCycleConfig::default()
    }
    .normalize()
}
thread_local! {static CYCLE_CACHE:RefCell<VecDeque<(String,Arc<CalibratedCylinderCycle>)>>=const {RefCell::new(VecDeque::new())};}
fn cached_legacy_cylinder_cycle(
    e: &EngineConfig,
    p: &PhysicalConfig,
    rpm: f64,
    throttle: f64,
    boundary: Option<&GasPathBoundary>,
    boost: f64,
) -> Result<Arc<CalibratedCylinderCycle>, String> {
    let config = cycle_config_for(e, p, rpm, throttle, boundary, boost)?;
    let mapped = sample_calibration_map(&p.ve_map, config.rpm, config.intake_pressure_pa / 1e5)?;
    let efficiency = p
        .indicated_efficiency_map
        .as_ref()
        .map(|m| sample_calibration_map(m, config.rpm, config.intake_pressure_pa / 1e5))
        .transpose()?;
    // Airflow mode and cam retards live in PhysicalConfig, not the cycle config, but change the result/warnings.
    let key = serde_json::to_string(&json!([
        config,
        p.airflow_model,
        p.intake_cam_retard_deg,
        p.exhaust_cam_retard_deg,
        mapped.value,
        mapped.extrapolated,
        efficiency.as_ref().map(|x| x.value),
        efficiency.as_ref().map(|x| x.extrapolated)
    ]))
    .map_err(|e| e.to_string())?;
    if let Some(hit) = CYCLE_CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        let index = cache.iter().position(|(k, _)| *k == key)?;
        let pair = cache.remove(index)?;
        let result = Arc::clone(&pair.1);
        cache.push_back(pair);
        Some(result)
    }) {
        return Ok(hit);
    }
    let swept = std::f64::consts::PI * config.bore_m.powi(2) / 4.0 * config.stroke_m;
    let rho = config.intake_pressure_pa / (AIR_R * config.intake_temperature_k);
    let mut candidate = config.clone();
    let mut result = None;
    let mut actual_ve = 0.0;
    let mut iterations = 0;
    let mut trials: Vec<VeTrial> = vec![];
    let fit = p.airflow_model == AirflowModel::VeMapFit;
    for i in 0..if fit { 3 } else { 1 } {
        let cycle = solve_cylinder_cycle(&candidate)?;
        iterations = i + 1;
        actual_ve = cycle.fresh_charge_mass_kg / (rho * swept);
        trials.push(VeTrial {
            lift_m: candidate.intake_valve_lift_m,
            actual_ve,
            seat_capped_fraction: seat_capped_fraction(
                candidate.intake_valve_lift_m,
                candidate.intake_valve_diameter_m,
            ),
            step_ratio_clamped: false,
            lift_bound_hit: false,
        });
        let eff = if cycle.fuel_energy_j > 0.0 {
            cycle.net_work_j / cycle.fuel_energy_j
        } else {
            0.0
        };
        let done = (actual_ve - mapped.value).abs() < 0.015
            && (efficiency
                .as_ref()
                .is_none_or(|t| cycle.fuel_mass_kg == 0.0 || (eff - t.value).abs() < 0.015));
        result = Some(cycle);
        if done || !fit {
            break;
        }
        let ratio = mapped.value / actual_ve.max(0.03);
        let proposed = candidate.intake_valve_lift_m * clamp(ratio, 0.5, 2.0);
        candidate.intake_valve_lift_m = clamp(proposed, 0.0002, 0.025);
        let last = trials.last_mut().unwrap();
        last.step_ratio_clamped = !(0.5..=2.0).contains(&ratio);
        last.lift_bound_hit = candidate.intake_valve_lift_m != proposed;
        if let Some(target) = &efficiency {
            if result.as_ref().unwrap().fuel_mass_kg > 0.0 {
                candidate.combustion_efficiency = clamp(
                    candidate.combustion_efficiency * clamp(target.value / eff.max(0.03), 0.5, 2.0),
                    0.1,
                    1.0,
                );
            }
        }
    }
    let mut solved = result.unwrap();
    let miss_classification = (fit && (actual_ve - mapped.value).abs() > 0.03).then(|| {
        classify_ve_miss(&trials).to_string()
    });
    // Legacy warning text kept verbatim; the classification lives in `missClassification`.
    if miss_classification.is_some() {
        solved.warnings.push("VE target not reached by the three bounded effective-intake-area trials; reported mass/work remain the actual solve.".to_string());
    }
    if let Some(w) = cam_clamp_warning(p, &solved.config) {
        solved.warnings.push(w);
    }
    if mapped.extrapolated || efficiency.as_ref().is_some_and(|e| e.extrapolated) {
        solved.warnings.push(
            "Calibration map sampled outside its declared domain; boundary values were clamped."
                .into(),
        );
    }
    let eff_residual = efficiency.as_ref().and_then(|target| {
        if solved.fuel_energy_j > 0.0 {
            Some(solved.net_work_j / solved.fuel_energy_j - target.value)
        } else {
            None
        }
    });
    if eff_residual.is_some_and(|v| v.abs() > 0.03) {
        solved.warnings.push(
            "Indicated-efficiency target not reached within bounded heat-input calibration.".into(),
        );
    }
    let effective_intake_lift_m = solved.config.intake_valve_lift_m;
    let calibrated = Arc::new(CalibratedCylinderCycle {
        result: solved,
        ecu: None,
        calibration: CycleCalibration {
            mapped_ve: mapped.value,
            actual_ve,
            ve_residual: actual_ve - mapped.value,
            extrapolated: mapped.extrapolated
                || efficiency.as_ref().is_some_and(|e| e.extrapolated),
            effective_intake_lift_m,
            iterations,
            airflow_model: p.airflow_model,
            trials,
            miss_classification,
            indicated_efficiency_target: efficiency.as_ref().map(|e| e.value),
            indicated_efficiency_residual: eff_residual,
        },
    });
    CYCLE_CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        cache.push_back((key, Arc::clone(&calibrated)));
        if cache.len() > 192 {
            cache.pop_front();
        }
    });
    Ok(calibrated)
}
/// Classify a missed VE target only from logged trial evidence.
fn classify_ve_miss(trials: &[VeTrial]) -> &'static str {
    if trials.iter().any(|t| t.lift_bound_hit) {
        return "lift-bound";
    }
    if trials.iter().any(|t| t.step_ratio_clamped) {
        return "step-ratio-limit";
    }
    // The proportional update assumes VE ~ lift (dVE/dlnL = VE); flag a much
    // weaker observed response, e.g. from seat-area capping or timing limits.
    if let [.., a, b] = trials {
        let slope = (b.actual_ve - a.actual_ve) / (b.lift_m / a.lift_m).ln();
        if slope.is_finite() && slope.abs() < 0.5 * 0.5 * (a.actual_ve + b.actual_ve) {
            return "sub-proportional-lift-response";
        }
    }
    "unproven"
}
/// Cam phasing must move opening and closing together; report kernel clamping.
fn cam_clamp_warning(p: &PhysicalConfig, c: &CylinderCycleConfig) -> Option<String> {
    let moved = [
        (p.intake_open_deg + p.intake_cam_retard_deg, c.intake_open_deg),
        (p.intake_close_deg + p.intake_cam_retard_deg, c.intake_close_deg),
        (p.exhaust_open_deg + p.exhaust_cam_retard_deg, c.exhaust_open_deg),
        (p.exhaust_close_deg + p.exhaust_cam_retard_deg, c.exhaust_close_deg),
    ];
    moved.iter().any(|(want, got)| (want - got).abs() > 1e-9).then(|| {
        "Cam-shifted valve event exceeded the kernel event bounds and was clamped; the event duration is no longer preserved.".into()
    })
}
pub fn get_cylinder_cycle(
    e: &EngineConfig,
    p: &PhysicalConfig,
    rpm: f64,
    throttle: f64,
    boundary: Option<&GasPathBoundary>,
    boost: f64,
) -> Result<CalibratedCylinderCycle, String> {
    if p.ecu.enabled {
        return Ok((*steady_controlled_cycle(
            e,
            p,
            rpm,
            throttle,
            boundary,
            boost,
            &ControlledPointOverrides::default(),
        )?)
        .clone());
    }
    Ok((*cached_legacy_cylinder_cycle(e, p, rpm, throttle, boundary, boost)?).clone())
}
fn estimate_from_cycle(
    e: &EngineConfig,
    p: &PhysicalConfig,
    rpm: f64,
    throttle: f64,
    cycle: &CalibratedCylinderCycle,
) -> Result<EngineEstimate, String> {
    let geometry = engine_geometry(e, p);
    let omega = rpm * TAU / 60.0;
    let frequency = e.cylinders as f64 * rpm / 120.0;
    let mean_piston_speed_ms = 2.0 * geometry.stroke_mm * 0.001 * rpm / 60.0;
    let fmep = p
        .fmep_map
        .as_ref()
        .map(|m| sample_calibration_map(m, rpm, cycle.config.intake_pressure_pa / 1e5))
        .transpose()?;
    let fmep_bar = fmep.as_ref().map(|m| m.value).unwrap_or(
        p.friction_base_bar
            + p.friction_speed_bar * mean_piston_speed_ms
            + 0.002 * mean_piston_speed_ms.powi(2),
    );
    let friction_torque_nm =
        fmep_bar * 1e5 * geometry.displacement_m3 / (4.0 * std::f64::consts::PI);
    let indicated_torque_nm =
        cycle.gross_work_j * e.cylinders as f64 / (4.0 * std::f64::consts::PI);
    let pumping_torque_nm =
        -cycle.pumping_work_j * e.cylinders as f64 / (4.0 * std::f64::consts::PI);
    let torque_nm =
        cycle.net_work_j * e.cylinders as f64 / (4.0 * std::f64::consts::PI) - friction_torque_nm;
    let power_kw = torque_nm * omega / 1000.0;
    let fuel_mass_flow_kgs = cycle
        .ecu
        .as_ref()
        .map(|s| s.state.delivered_fuel_mass_flow_kgs)
        .unwrap_or(cycle.fuel_mass_kg * frequency);
    let fuel_power_kw = cycle
        .ecu
        .as_ref()
        .map(|s| fuel_mass_flow_kgs * s.state.fuel_lhv_jkg / 1000.0)
        .unwrap_or(fuel_mass_flow_kgs * p.fuel_lhv_mjkg * 1000.0);
    let sample = |angle: f64, values: &Vec<f64>| -> f64 {
        let mut best = 0;
        for i in 1..cycle.trace.angle_deg.len() {
            if (cycle.trace.angle_deg[i] - angle).abs()
                < (cycle.trace.angle_deg[best] - angle).abs()
            {
                best = i
            }
        }
        values[best]
    };
    let peak = cycle.peak_pressure_pa / 1e5;
    let mut screen_flags = vec![];
    if peak > p.assumed_peak_pressure_bar {
        screen_flags.push("pressure-assumption".into())
    }
    if mean_piston_speed_ms > p.assumed_mean_piston_speed_ms {
        screen_flags.push("piston-speed-assumption".into())
    }
    if rpm >= e.redline {
        screen_flags.push("redline".into())
    }
    let crank_radius = geometry.stroke_mm * 0.001 / 2.0;
    let rod_m = geometry.rod_length_mm * 0.001;
    let mut warnings = cycle.warnings.clone();
    if let Some(efi) = &cycle.ecu {
        for flag in &efi.coupling_flags {
            if !warnings.contains(flag) {
                warnings.push(flag.clone());
            }
        }
    }
    if fmep.as_ref().is_some_and(|f| f.extrapolated) {
        warnings.push("FMEP map outside declared domain; boundary value clamped.".into())
    }
    Ok(EngineEstimate {
        rpm,
        throttle,
        torque_nm,
        power_kw,
        power_hp: power_kw * 1000.0 / 745.699872,
        indicated_torque_nm,
        friction_torque_nm,
        pumping_torque_nm,
        bmep_bar: torque_nm * 4.0 * std::f64::consts::PI / geometry.displacement_m3 / 1e5,
        fmep_bar,
        manifold_pressure_bar: cycle.config.intake_pressure_pa / 1e5,
        ivc_pressure_bar: sample(cycle.config.intake_close_deg, &cycle.trace.pressure_pa) / 1e5,
        air_mass_flow_kgs: cycle.fresh_charge_mass_kg * frequency,
        net_inlet_air_mass_flow_kgs: (cycle.intake_mass_in_kg - cycle.intake_reverse_mass_kg)
            * frequency,
        fuel_mass_flow_kgs,
        fuel_power_kw,
        brake_efficiency: if fuel_power_kw > 0.0 {
            power_kw.max(0.0) / fuel_power_kw
        } else {
            0.0
        },
        otto_efficiency: if p.ecu.enabled
            && p.ecu.combustion_mode == CombustionMode::DirectInjectionDiesel
        {
            0.0
        } else {
            1.0 - e.compression.powf(1.0 - p.gamma)
        },
        compression_pressure_bar: sample(cycle.soc_deg, &cycle.trace.pressure_pa) / 1e5,
        compression_temperature_k: sample(cycle.soc_deg, &cycle.trace.temperature_k),
        ideal_peak_pressure_bar: peak,
        ideal_peak_gas_temperature_k: cycle.peak_temperature_k,
        mean_piston_speed_ms,
        ideal_gas_force_n: (peak - p.ambient_pressure_bar).max(0.0) * 1e5 * geometry.piston_area_m2,
        inertia_force_tdc_n: p.reciprocating_mass_kg
            * crank_radius
            * omega.powi(2)
            * (1.0 + crank_radius / rod_m),
        fuel_cut: if cycle.ecu.is_some() {
            cycle.released_heat_j <= 1e-15
        } else {
            cycle.fuel_mass_kg == 0.0
        },
        screen_flags,
        geometry,
        exhaust_pressure_bar: cycle.config.exhaust_pressure_pa / 1e5,
        exhaust_temperature_k: cycle.exhaust_temperature_k,
        mapped_volumetric_efficiency: cycle.calibration.mapped_ve,
        actual_volumetric_efficiency: cycle.calibration.actual_ve,
        ve_target_residual: cycle.calibration.ve_residual,
        map_extrapolated: cycle.calibration.extrapolated
            || fmep.as_ref().is_some_and(|f| f.extrapolated),
        calibration_source: p.ve_map.provenance.source.clone(),
        wall_heat_loss_w: cycle.wall_heat_loss_j * frequency,
        cycle: CycleSummary {
            net_work_j: cycle.net_work_j,
            gross_work_j: cycle.gross_work_j,
            pumping_work_j: cycle.pumping_work_j,
            peak_pressure_pa: cycle.peak_pressure_pa,
            peak_temperature_k: cycle.peak_temperature_k,
            peak_pressure_rise_pa_per_deg: cycle.peak_pressure_rise_pa_per_deg,
            mass_balance_residual_kg: cycle.mass_balance_residual_kg,
            energy_balance_residual_j: cycle.energy_balance_residual_j,
            periodic_mass_relative_error: cycle.periodic_mass_relative_error,
            periodic_energy_relative_error: cycle.periodic_energy_relative_error,
            ca50_deg: cycle.ca50_deg,
            residual_fraction: cycle.residual_fraction_at_ivc,
            lookup_rpm: cycle.config.rpm,
            lookup_intake_pressure_bar: cycle.config.intake_pressure_pa / 1e5,
            soc_deg: cycle.soc_deg,
            ca10_deg: cycle.ca10_deg,
            ca90_deg: cycle.ca90_deg,
            valve_events_deg: [
                cycle.config.intake_open_deg,
                cycle.config.intake_close_deg,
                cycle.config.exhaust_open_deg,
                cycle.config.exhaust_close_deg,
            ],
            trapped_fresh_mass_kg: cycle.fresh_charge_mass_kg,
            intake_in_mass_kg: cycle.intake_mass_in_kg,
            intake_reverse_mass_kg: cycle.intake_reverse_mass_kg,
            wall_heat_loss_j: cycle.wall_heat_loss_j,
            peak_heat_transfer_wm2_k: cycle.peak_heat_transfer_wm2_k,
        },
        warnings,
        ecu: cycle.ecu.clone(),
    })
}
pub fn evaluate_engine(
    e: &EngineConfig,
    p: &PhysicalConfig,
    input_rpm: f64,
    input_throttle: f64,
    boost: f64,
) -> Result<EngineEstimate, String> {
    evaluate_engine_at_boundary(e, p, input_rpm, input_throttle, boost, None)
}
/// Steady estimate (cycle + Rust friction/brake equations) at an optional fixed
/// gas-path boundary, e.g. measured MAP/IAT and exhaust proxies. Static only.
pub fn evaluate_engine_at_boundary(
    e: &EngineConfig,
    p: &PhysicalConfig,
    input_rpm: f64,
    input_throttle: f64,
    boost: f64,
    boundary: Option<&GasPathBoundary>,
) -> Result<EngineEstimate, String> {
    let rpm = bounded(input_rpm, e.idle_rpm, 0.0, e.redline * 1.2);
    let throttle = bounded(input_throttle, 0.0, 0.0, 1.0);
    let cycle = if p.ecu.enabled {
        steady_controlled_cycle(
            e,
            p,
            rpm,
            throttle,
            boundary,
            boost,
            &ControlledPointOverrides::default(),
        )?
    } else {
        cached_legacy_cylinder_cycle(e, p, rpm, throttle, boundary, boost)?
    };
    estimate_from_cycle(e, p, rpm, throttle, cycle.as_ref())
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ControlledPointOverrides {
    pub target_lambda: Option<f64>,
    pub spark_advance_deg: Option<f64>,
    pub diesel_quantity_mg_per_cylinder: Option<f64>,
    pub injection_start_deg_btdc: Option<f64>,
}
fn diesel_active(p: &PhysicalConfig) -> bool {
    p.ecu.enabled && p.ecu.combustion_mode == CombustionMode::DirectInjectionDiesel
}
fn air_throttle_for(p: &PhysicalConfig, pedal: f64) -> f64 {
    if diesel_active(p) {
        p.ecu.diesel.air_throttle_fraction
    } else {
        pedal
    }
}
/// Pure warm open-loop controller/actuator evaluation; no live history is reused.
pub fn evaluate_controlled_point(
    e: &EngineConfig,
    p: &PhysicalConfig,
    rpm: f64,
    throttle: f64,
    target_lambda_override: Option<f64>,
    spark_advance_override: Option<f64>,
) -> Result<EngineEstimate, String> {
    evaluate_controlled_point_with_overrides(
        e,
        p,
        rpm,
        throttle,
        &ControlledPointOverrides {
            target_lambda: target_lambda_override,
            spark_advance_deg: spark_advance_override,
            ..Default::default()
        },
    )
}
pub fn evaluate_controlled_point_with_overrides(
    e: &EngineConfig,
    p: &PhysicalConfig,
    rpm: f64,
    pedal: f64,
    overrides: &ControlledPointOverrides,
) -> Result<EngineEstimate, String> {
    if !p.ecu.enabled {
        return Err("EFI must be enabled for the controlled-point seam.".into());
    }
    let rpm = bounded(rpm, e.idle_rpm, 300.0, e.redline * 1.2);
    let pedal = bounded(pedal, 0.0, 0.0, 1.0);
    let cycle = steady_controlled_cycle(e, p, rpm, pedal, None, 1.0, overrides)?;
    estimate_from_cycle(e, p, rpm, pedal, cycle.as_ref())
}
fn pressure_at_angle(cycle: &CalibratedCylinderCycle, angle: f64) -> f64 {
    let angles = &cycle.trace.angle_deg;
    let pressures = &cycle.trace.pressure_pa;
    let angle = clamp(angle, 0.0, 720.0);
    let mut i = 0;
    while i + 2 < angles.len() && angles[i + 1] < angle {
        i += 1;
    }
    let fraction = (angle - angles[i]) / (angles[i + 1] - angles[i]);
    pressures[i] + (pressures[i + 1] - pressures[i]) * fraction
}
fn ecu_input_for(
    e: &EngineConfig,
    cfg: &EcuConfig,
    rpm: f64,
    pedal: f64,
    boundary: &GasPathBoundary,
    fresh_air_flow: f64,
    coolant_k: f64,
    held: &CalibratedCylinderCycle,
    quantity_override: Option<f64>,
) -> Result<EcuInput, String> {
    let ci = cfg.combustion_mode == CombustionMode::DirectInjectionDiesel;
    let downstream = if ci {
        let soi = cfg
            .diesel
            .injection_advance_map
            .sample(rpm, boundary.intake_pressure_pa / 1e5)?
            .value;
        Some(pressure_at_angle(held, 360.0 - soi))
    } else {
        None
    };
    Ok(EcuInput {
        rpm,
        cylinders: e.cylinders,
        displacement_l: e.displacement,
        map_pressure_pa: boundary.intake_pressure_pa,
        intake_temperature_k: boundary.intake_temperature_k,
        coolant_temperature_k: coolant_k,
        throttle: pedal,
        battery_voltage_v: cfg.battery_voltage_v,
        actual_air_mass_flow_kgs: fresh_air_flow.max(0.0),
        injector_cut: if ci { rpm >= e.redline } else { pedal < 0.005 },
        combustion_cut: !ci && rpm >= e.redline,
        actual_rail_pressure_pa: None,
        sensor_valid: true,
        injection_downstream_pressure_pa: downstream,
        requested_fuel_quantity_override_mg: quantity_override,
    })
}
thread_local! {static CONTROLLED_CYCLE_CACHE:RefCell<VecDeque<(String,Arc<CylinderCycleResult>)>>=const {RefCell::new(VecDeque::new())};}
fn controlled_cycle_from_state(
    e: &EngineConfig,
    p: &PhysicalConfig,
    base: &CalibratedCylinderCycle,
    state: &EcuState,
    rpm: f64,
    mode: &str,
) -> Result<CalibratedCylinderCycle, String> {
    let mut config = base.config.clone();
    config.fuel_mass_kg = Some(state.fuel_mass_per_cylinder_cycle_kg.max(0.0));
    config.fuel_lhv_jkg = state.fuel_lhv_jkg;
    let ci = state.combustion_mode == CombustionMode::DirectInjectionDiesel;
    config.spark_advance_deg = if ci { 0.0 } else { state.spark_advance_deg };
    config.combustion_start_deg = if ci {
        state.start_of_combustion_deg
    } else {
        None
    };
    config.burn_duration_deg = if ci {
        state
            .prescribed_burn_duration_deg
            .unwrap_or(p.ecu.diesel.burn_duration_deg)
    } else {
        base.config.burn_duration_deg
    };
    config.fuel_delivery_start_deg = None;
    config.fuel_delivery_duration_deg = None;
    if ci {
        if let (Some(start), Some(duration)) = (
            state.injection_start_angle_deg,
            state.effective_injection_duration_deg,
        ) {
            if duration > 0.0 && state.fuel_mass_per_cylinder_cycle_kg > 0.0 {
                config.fuel_delivery_start_deg = Some(start);
                config.fuel_delivery_duration_deg = Some(duration);
            }
        }
    }
    config.combustion_efficiency = if state.combustion_cut {
        0.0
    } else if ci {
        p.combustion_efficiency
    } else {
        base.config.combustion_efficiency
    };
    config.oxygen_limit_afr = Some(state.stoich_afr);
    let normalized = config.clone().normalize()?;
    let mut kernel_config = normalized.clone();
    let heat_free = normalized.combustion_efficiency == 0.0 || normalized.fuel_mass_kg == Some(0.0);
    if heat_free {
        kernel_config.fuel_mass_kg = Some(0.0);
        kernel_config.fuel_lhv_jkg = 43e6;
        kernel_config.oxygen_limit_afr = None;
    }
    let key = serde_json::to_string(&kernel_config).map_err(|e| e.to_string())?;
    let found = CONTROLLED_CYCLE_CACHE.with(|cache| {
        cache
            .borrow()
            .iter()
            .find(|(k, _)| *k == key)
            .map(|(_, v)| Arc::clone(v))
    });
    let solved = if let Some(hit) = found {
        hit
    } else {
        let result = Arc::new(solve_cylinder_cycle(&kernel_config)?);
        CONTROLLED_CYCLE_CACHE.with(|cache| {
            let mut cache = cache.borrow_mut();
            cache.push_back((key, Arc::clone(&result)));
            if cache.len() > 192 {
                cache.pop_front();
            }
        });
        result
    };
    let mut result = (*solved).clone();
    if heat_free {
        // At zero heat coefficient, fuel changes only accounting: no fuel mass
        // enters the air-standard working gas and all pressure/flow states agree.
        result.config = normalized.clone();
        result.fuel_mass_kg = normalized.fuel_mass_kg.unwrap_or(0.0);
        result.fuel_energy_j = result.fuel_mass_kg * normalized.fuel_lhv_jkg;
        let eligible = result.fuel_mass_kg.min(
            result.fresh_charge_mass_kg / normalized.oxygen_limit_afr.unwrap_or(state.stoich_afr),
        );
        result.oxygen_limited_fuel_mass_kg = Some(eligible);
        result.oxygen_unburned_fuel_mass_kg = Some((result.fuel_mass_kg - eligible).max(0.0));
    }
    let frequency = e.cylinders as f64 * rpm / 120.0;
    let actual_air = result.fresh_charge_mass_kg * frequency;
    let demanded = state.fuel_mass_per_cylinder_cycle_kg;
    let fuel_mismatch = (result.fuel_mass_kg - demanded).abs() / demanded.max(1e-12);
    let mut flags=vec!["Pressure cycle uses delivered vapor fuel; air-standard oxygen cap is not chemistry or an emissions prediction.".to_string()];
    if fuel_mismatch > 1e-8 {
        flags.push("Delivered fuel lies outside cylinder mass domain; cycle and actuator fuel mismatch is quantitatively invalid.".into());
    }
    if (normalized.fuel_lhv_jkg - state.fuel_lhv_jkg).abs() > 1e-6 {
        flags.push("Delivered fuel LHV lies outside the cylinder property domain; quantitative prediction is invalid.".into());
    }
    let actual_burnable = result
        .oxygen_limited_fuel_mass_kg
        .unwrap_or(result.fuel_mass_kg);
    let oxygen_limited = result.oxygen_unburned_fuel_mass_kg.unwrap_or(0.0) > 1e-12;
    let reference_fuel = if ci {
        &p.ecu.diesel.fuel
    } else {
        &p.ecu.fuel.gasoline
    };
    let reference_heat = result.fresh_charge_mass_kg / reference_fuel.stoich_afr
        * reference_fuel.lhv_jkg
        * if ci {
            p.combustion_efficiency
        } else {
            base.config.combustion_efficiency
        };
    let energy_scale = if reference_heat > 1e-12 {
        result.released_heat_j / reference_heat
    } else {
        0.0
    };
    let mut reported = state.clone();
    reported.actual_air_mass_flow_kgs = actual_air;
    reported.true_lambda = if state.delivered_fuel_mass_flow_kgs > 1e-15 {
        Some(actual_air / (state.delivered_fuel_mass_flow_kgs * state.stoich_afr))
    } else {
        None
    };
    reported.burnable_fuel_mass_per_cylinder_cycle_kg = if state.combustion_cut {
        0.0
    } else {
        actual_burnable
    };
    reported.burnable_fuel_mass_flow_kgs =
        reported.burnable_fuel_mass_per_cylinder_cycle_kg * frequency;
    reported.unburned_fuel_mass_flow_kgs =
        (state.delivered_fuel_mass_flow_kgs - reported.burnable_fuel_mass_flow_kgs).max(0.0);
    reported.burnable_fuel_energy_w = reported.burnable_fuel_mass_flow_kgs * state.fuel_lhv_jkg;
    let injection_reference = if ci {
        Some(state.rail_pressure_pa - state.delta_pressure_pa)
    } else {
        None
    };
    let injection_actual = if ci {
        state.injection_start_angle_deg.map(|angle| {
            let angles = &result.trace.angle_deg;
            let values = &result.trace.pressure_pa;
            let mut i = 0;
            while i + 2 < angles.len() && angles[i + 1] < angle {
                i += 1;
            }
            let fraction = (angle - angles[i]) / (angles[i + 1] - angles[i]);
            values[i] + (values[i + 1] - values[i]) * fraction
        })
    } else {
        None
    };
    let injection_mismatch = injection_reference
        .zip(injection_actual)
        .map(|(a, b)| (a - b).abs() / state.delta_pressure_pa.max(1000.0));
    if ci {
        flags.push("Diesel uses prescribed hydraulic single-main SOI, delay and burn; no spray, cetane, knock or emissions model.".into());
    }
    if injection_mismatch.is_some_and(|r| r > 0.02) {
        flags.push("Held SOI cylinder-pressure coupling changes injector differential pressure by over 2%; quantity prediction is qualitative.".into());
    }
    let valid = state.quantitatively_valid
        && injection_mismatch.is_none_or(|r| r <= 0.02)
        && fuel_mismatch <= 1e-8
        && (normalized.fuel_lhv_jkg - state.fuel_lhv_jkg).abs() <= 1e-6;
    let rho = result.config.intake_pressure_pa / (AIR_R * result.config.intake_temperature_k);
    let g = engine_geometry(e, p);
    let actual_ve = result.fresh_charge_mass_kg / (rho * g.cylinder_displacement_m3);
    let mut calibration = base.calibration.clone();
    calibration.actual_ve = actual_ve;
    calibration.ve_residual = actual_ve - calibration.mapped_ve;
    result.warnings.push("EFI controls fuel/spark only; the plant's accepted effective intake geometry was not refitted to hide delivery error.".into());
    let ecu = EcuCouplingSummary {
        state: reported,
        coupling_mode: mode.into(),
        plant_lambda: if result.fuel_mass_kg > 1e-15 {
            Some(result.fresh_charge_mass_kg / (result.fuel_mass_kg * state.stoich_afr))
        } else {
            None
        },
        cycle_released_heat_j: result.released_heat_j,
        cycle_fuel_energy_j: result.fuel_energy_j,
        cycle_fuel_mass_kg: result.fuel_mass_kg,
        demanded_cycle_fuel_mass_kg: demanded,
        fuel_mass_relative_mismatch: fuel_mismatch,
        fresh_air_mass_flow_kgs: actual_air,
        combustion_energy_scale: energy_scale,
        oxygen_limited,
        coupling_quantitatively_valid: valid,
        coupling_flags: flags,
        injection_pressure_reference_pa: injection_reference,
        cycle_injection_pressure_pa: injection_actual,
        injection_pressure_relative_mismatch: injection_mismatch,
    };
    Ok(CalibratedCylinderCycle {
        result,
        calibration,
        ecu: Some(ecu),
    })
}
fn efi_breathing_reference(p: &PhysicalConfig) -> PhysicalConfig {
    // A fixed declared nominal-fuel reference sets the plant's effective valve
    // geometry. Controller VE/lambda/correction and legacy AFR cannot retune it.
    let mut reference = p.clone();
    if diesel_active(p) {
        reference.air_fuel_ratio = p.ecu.diesel.fuel.stoich_afr;
        reference.fuel_lhv_mjkg = p.ecu.diesel.fuel.lhv_jkg / 1e6;
        reference.combustion_efficiency = 0.0;
    } else {
        reference.air_fuel_ratio = p.ecu.fuel.gasoline.stoich_afr;
        reference.fuel_lhv_mjkg = p.ecu.fuel.gasoline.lhv_jkg / 1e6;
    }
    reference
}
fn steady_controlled_cycle(
    e: &EngineConfig,
    p: &PhysicalConfig,
    rpm: f64,
    pedal: f64,
    boundary: Option<&GasPathBoundary>,
    boost: f64,
    overrides: &ControlledPointOverrides,
) -> Result<Arc<CalibratedCylinderCycle>, String> {
    let mut cfg = p.ecu.clone();
    let ci = cfg.combustion_mode == CombustionMode::DirectInjectionDiesel;
    if ci {
        if overrides.target_lambda.is_some() || overrides.spark_advance_deg.is_some() {
            return Err("Diesel control accepts fuel quantity and SOI; SI lambda/spark overrides are unsupported.".into());
        }
        if let Some(value) = overrides.diesel_quantity_mg_per_cylinder {
            if !value.is_finite() || !(0.0..=500.0).contains(&value) {
                return Err(
                    "Diesel quantity override must be finite 0..500 mg/cylinder/720 degrees."
                        .into(),
                );
            }
        }
        if let Some(value) = overrides.injection_start_deg_btdc {
            if !value.is_finite() {
                return Err("Diesel SOI must be finite.".into());
            }
            for row in &mut cfg.diesel.injection_advance_map.values {
                row.fill(value);
            }
            cfg.diesel.injection_advance_map.validate()?;
        }
    } else {
        if overrides.diesel_quantity_mg_per_cylinder.is_some()
            || overrides.injection_start_deg_btdc.is_some()
        {
            return Err(
                "Diesel quantity/SOI overrides require direct-injection diesel mode.".into(),
            );
        }
        if let Some(value) = overrides.target_lambda {
            if !value.is_finite() || !(0.65..=1.4).contains(&value) {
                return Err("Target lambda override must be 0.65..1.4.".into());
            }
            for row in &mut cfg.lambda_target_map.values {
                row.fill(value);
            }
        }
        if let Some(value) = overrides.spark_advance_deg {
            if !value.is_finite() || !(-10.0..=50.0).contains(&value) {
                return Err("Spark override must be -10..50 degrees BTDC.".into());
            }
            for row in &mut cfg.spark_advance_map.values {
                row.fill(value);
            }
        }
    }
    let breathing_reference = efi_breathing_reference(p);
    let base = cached_legacy_cylinder_cycle(e, &breathing_reference, rpm, pedal, boundary, boost)?;
    let b = GasPathBoundary {
        intake_pressure_pa: base.config.intake_pressure_pa,
        intake_temperature_k: base.config.intake_temperature_k,
        exhaust_pressure_pa: base.config.exhaust_pressure_pa,
        exhaust_temperature_k: base.config.exhaust_temperature_k,
    };
    let input = ecu_input_for(
        e,
        &cfg,
        rpm,
        pedal,
        &b,
        base.fresh_charge_mass_kg * e.cylinders as f64 * rpm / 120.0,
        p.thermal
            .initial_coolant_temperature_k
            .max(cfg.film.reference_temperature_k),
        &base,
        overrides.diesel_quantity_mg_per_cylinder,
    )?;
    let state = evaluate_ecu_steady(e, &cfg, &input)?;
    let mut cycle = controlled_cycle_from_state(e, p, &base, &state, rpm, "steady-open-loop")?;
    if ci {
        // One bounded hydraulic correction uses the first fired cycle's cylinder
        // pressure at SOI. Controller air estimation still receives no plant truth.
        let input = ecu_input_for(
            e,
            &cfg,
            rpm,
            pedal,
            &b,
            cycle.fresh_charge_mass_kg * e.cylinders as f64 * rpm / 120.0,
            input.coolant_temperature_k,
            &cycle,
            overrides.diesel_quantity_mg_per_cylinder,
        )?;
        let state = evaluate_ecu_steady(e, &cfg, &input)?;
        cycle = controlled_cycle_from_state(e, p, &base, &state, rpm, "steady-open-loop")?;
    }
    Ok(Arc::new(cycle))
}

pub fn potential_envelope(
    e: &EngineConfig,
    p: &PhysicalConfig,
    samples: usize,
) -> Result<PotentialEnvelope, String> {
    let count = samples.clamp(8, 256);
    let mut points = Vec::with_capacity(count);
    for index in 0..count {
        points.push(evaluate_engine(
            e,
            p,
            e.idle_rpm + (e.redline * 0.995 - e.idle_rpm) * index as f64 / (count - 1) as f64,
            1.0,
            1.0,
        )?)
    }
    let mut peak_power = points[0].clone();
    let mut peak_torque = points[0].clone();
    let mut screened: Option<EngineEstimate> = None;
    let mut limiting_causes = vec![];
    for point in &points {
        if point.power_kw > peak_power.power_kw {
            peak_power = point.clone()
        }
        if point.torque_nm > peak_torque.torque_nm {
            peak_torque = point.clone()
        }
        if point.screen_flags.is_empty()
            && screened
                .as_ref()
                .is_none_or(|s| point.power_kw > s.power_kw)
        {
            screened = Some(point.clone())
        }
        for cause in &point.screen_flags {
            if !limiting_causes.contains(cause) {
                limiting_causes.push(cause.clone())
            }
        }
    }
    Ok(PotentialEnvelope {
        points,
        peak_power,
        peak_torque,
        screened_peak_power: screened,
        limiting_causes,
        status: "uncalibrated-assumptions".into(),
    })
}
pub fn transmitted_wheel_torque(torque: f64, ratio: f64, efficiency: f64) -> f64 {
    torque
        * ratio
        * if torque >= 0.0 {
            efficiency
        } else {
            1.0 / efficiency
        }
}
pub fn passive_clutch_impulse(
    engine_omega: f64,
    wheel_omega: f64,
    ratio: f64,
    engine_inertia: f64,
    vehicle_mass: f64,
    tyre_radius: f64,
    efficiency: f64,
    engagement: f64,
    dt: f64,
) -> f64 {
    if dt <= 0.0 || engagement <= 0.0 {
        return 0.0;
    }
    let slip = engine_omega - wheel_omega * ratio;
    let transfer = if slip >= 0.0 {
        efficiency
    } else {
        1.0 / efficiency
    };
    let wheel_inverse = ratio.powi(2) / (vehicle_mass * tyre_radius.powi(2));
    let relative_inverse = 1.0 / engine_inertia + transfer * wheel_inverse;
    let energy_inverse = 1.0 / engine_inertia + transfer.powi(2) * wheel_inverse;
    let analytic =
        slip * (-(-5.0 * engagement * relative_inverse * dt).exp_m1()) / relative_inverse;
    let no_cross = slip.abs() / relative_inverse.max(energy_inverse);
    slip.signum() * analytic.abs().min(450.0 * dt).min(no_cross)
}
#[derive(Clone, Debug)]
struct Variation {
    energy: f64,
    duration: f64,
    phase: f64,
}
pub struct Powertrain {
    engine: Arc<EngineConfig>,
    physical: Arc<PhysicalConfig>,
    omega: f64,
    speed: f64,
    turbo_energy_j: f64,
    boost_fraction: f64,
    gas: GasPath,
    thermal: ThermalNetwork,
    last: Option<PowertrainState>,
    cycle_progress: f64,
    cycle_index: u64,
    variation: Variation,
    lookup_elapsed: f64,
    operating: Option<Arc<EngineEstimate>>,
    operating_cycle: Option<Arc<CalibratedCylinderCycle>>,
    ecu: Ecu,
    efi_base_cycle: Option<Arc<CalibratedCylinderCycle>>,
    efi_fueled_cycle: Option<Arc<CalibratedCylinderCycle>>,
    efi_refresh_elapsed: f64,
    online_cache: VecDeque<(String, Arc<CalibratedCylinderCycle>)>,
}
impl Powertrain {
    pub fn new(engine: EngineConfig, physical: PhysicalConfig) -> Result<Self, String> {
        let physical = PhysicalConfig::from_value(
            &engine,
            &serde_json::to_value(physical).map_err(|e| e.to_string())?,
        )?;
        let mut gas = GasPath::new(gas_path_config_for(&engine, &physical))?;
        let b = steady_boundary(
            &engine,
            &physical,
            engine.idle_rpm,
            air_throttle_for(&physical, 0.036),
            0.0,
        )?;
        gas.reset(GasPathReset {
            intake_pressure_pa: Some(b.intake_pressure_pa),
            intake_temperature_k: Some(b.intake_temperature_k),
            exhaust_pressure_pa: Some(b.exhaust_pressure_pa),
            exhaust_temperature_k: Some(b.exhaust_temperature_k),
        })?;
        let thermal = ThermalNetwork::new(physical.thermal.clone());
        let omega = engine.idle_rpm * TAU / 60.0;
        let ecu = Ecu::new(physical.ecu.clone());
        let mut this = Self {
            engine: Arc::new(engine),
            physical: Arc::new(physical),
            omega,
            speed: 0.0,
            turbo_energy_j: 0.0,
            boost_fraction: 0.0,
            gas,
            thermal,
            last: None,
            cycle_progress: 0.0,
            cycle_index: 0,
            variation: Variation {
                energy: 1.0,
                duration: 1.0,
                phase: 0.0,
            },
            lookup_elapsed: 1.0,
            operating: None,
            operating_cycle: None,
            online_cache: VecDeque::new(),
            ecu,
            efi_base_cycle: None,
            efi_fueled_cycle: None,
            efi_refresh_elapsed: 1.0,
        };
        this.last = Some(this.empty_state());
        Ok(this)
    }
    fn audio_state(&self, fuel_cut: bool) -> PhysicalAudioState {
        let gas = self.gas.get_state();
        let efi = if self.physical.ecu.enabled {
            Some(self.ecu.get_state())
        } else {
            None
        };
        let fuel_cut = efi
            .as_ref()
            .map(|s| s.combustion_cut || s.burnable_fuel_mass_flow_kgs <= 1e-15)
            .unwrap_or(fuel_cut);
        let energy_scale = efi
            .as_ref()
            .map(|s| self.efi_audio_energy_scale(s))
            .unwrap_or(1.0);
        PhysicalAudioState {
            boost_bar: self.engine.boost_bar * self.boost_fraction,
            fuel_cut,
            intake_pressure_bar: gas.intake.pressure_pa / 1e5,
            exhaust_pressure_bar: gas.exhaust.pressure_pa / 1e5,
            exhaust_mass_flow_kgs: gas.cylinder_exhaust_mass_flow_kgs.max(0.0),
            exhaust_temperature_k: gas.exhaust.temperature_k,
            cycle_energy_scale: self.variation.energy * energy_scale,
            burn_duration_scale: self.variation.duration,
            combustion_phase_deg: self.variation.phase,
            residual_fraction: self
                .operating
                .as_ref()
                .map(|p| p.cycle.residual_fraction)
                .unwrap_or(0.0),
            cycle_index: self.cycle_index as f64,
        }
    }
    fn empty_state(&self) -> PowertrainState {
        let physical = self.audio_state(false);
        PowertrainState {
            rpm: self.omega * 60.0 / TAU,
            load: 0.14,
            throttle: 0.0,
            speed_ms: self.speed,
            speed_kmh: self.speed * 3.6,
            acceleration_ms2: 0.0,
            gear: 0.0,
            clutch: 0.0,
            torque_nm: 0.0,
            power_kw: 0.0,
            resistance_n: 0.0,
            traction_n: 0.0,
            boost_fraction: self.boost_fraction,
            quantitatively_valid: true,
            physical_audio: physical.clone(),
            physical,
            gas_path: self.gas.get_state(),
            thermal: self.thermal.get_state(),
            warnings: vec![],
            ecu: if self.physical.ecu.enabled {
                Some(self.ecu.get_state())
            } else {
                None
            },
            ecu_coupling: None,
        }
    }
    pub fn set_config(
        &mut self,
        engine: EngineConfig,
        physical: PhysicalConfig,
    ) -> Result<(), String> {
        let physical = PhysicalConfig::from_value(
            &engine,
            &serde_json::to_value(physical).map_err(|e| e.to_string())?,
        )?;
        // Validate all rejecting operations on snapshots before changing any
        // live inventory, cache, thermal state, controller, or configuration.
        let mut checked_ecu = self.ecu.clone();
        checked_ecu.set_config(physical.ecu.clone())?;
        let mut checked_gas = self.gas.clone();
        checked_gas.configure(gas_path_config_for(&engine, &physical))?;
        let mut checked_thermal = self.thermal.clone();
        checked_thermal.set_config(physical.thermal.clone());
        if serde_json::to_value((&engine, &physical)).map_err(|e| e.to_string())?
            != serde_json::to_value((self.engine.as_ref(), self.physical.as_ref()))
                .map_err(|e| e.to_string())?
        {
            self.operating = None;
            self.operating_cycle = None;
            self.online_cache.clear();
            self.efi_base_cycle = None;
            self.efi_fueled_cycle = None;
            self.efi_refresh_elapsed = 1.0;
            self.lookup_elapsed = 1.0;
        }
        self.gas = checked_gas;
        self.thermal = checked_thermal;
        self.ecu = checked_ecu;
        self.omega = clamp(
            self.omega,
            engine.idle_rpm * TAU / 60.0,
            engine.redline * TAU / 60.0,
        );
        if engine.boost_bar == 0.0 {
            self.turbo_energy_j = 0.0;
            self.boost_fraction = 0.0;
        }
        self.engine = Arc::new(engine);
        self.physical = Arc::new(physical);
        Ok(())
    }
    pub fn reset(
        &mut self,
        rpm: Option<f64>,
        speed_ms: Option<f64>,
    ) -> Result<PowertrainState, String> {
        self.omega = bounded(
            rpm.unwrap_or(f64::NAN),
            self.engine.idle_rpm,
            self.engine.idle_rpm,
            self.engine.redline,
        ) * TAU
            / 60.0;
        self.speed = bounded(speed_ms.unwrap_or(f64::NAN), 0.0, 0.0, 150.0);
        self.turbo_energy_j = 0.0;
        self.boost_fraction = 0.0;
        self.cycle_progress = 0.0;
        self.cycle_index = 0;
        self.variation = Variation {
            energy: 1.0,
            duration: 1.0,
            phase: 0.0,
        };
        self.lookup_elapsed = 1.0;
        self.operating = None;
        self.operating_cycle = None;
        self.efi_base_cycle = None;
        self.efi_fueled_cycle = None;
        self.efi_refresh_elapsed = 1.0;
        let b = steady_boundary(
            &self.engine,
            &self.physical,
            self.omega * 60.0 / TAU,
            air_throttle_for(&self.physical, 0.036),
            0.0,
        )?;
        self.gas.reset(GasPathReset {
            intake_pressure_pa: Some(b.intake_pressure_pa),
            intake_temperature_k: Some(b.intake_temperature_k),
            exhaust_pressure_pa: Some(b.exhaust_pressure_pa),
            exhaust_temperature_k: Some(b.exhaust_temperature_k),
        })?;
        self.thermal.reset();
        self.ecu.reset();
        self.last = Some(self.empty_state());
        Ok(self.get_state())
    }
    pub fn get_state(&self) -> PowertrainState {
        self.last.as_ref().expect("initialized state").clone()
    }
    pub fn get_operating_estimate(&self) -> Option<EngineEstimate> {
        self.operating.as_ref().map(|value| (**value).clone())
    }
    fn refresh_operating(&mut self, rpm: f64, throttle: f64) -> Result<(), String> {
        let gas = self.gas.get_state();
        let cut = throttle < 0.005 || rpm >= self.engine.redline;
        let q = |x: f64, s: f64| (x / s).round() * s;
        let lookup_rpm = (self.engine.redline - 1.0).min(clamp(q(rpm, 500.0), 300.0, 18000.0));
        let boundary = GasPathBoundary {
            intake_pressure_pa: clamp(q(gas.intake.pressure_pa, 10000.0), 15000.0, 500000.0),
            intake_temperature_k: clamp(q(gas.intake.temperature_k, 25.0), 230.0, 600.0),
            exhaust_pressure_pa: clamp(q(gas.exhaust.pressure_pa, 10000.0), 30000.0, 700000.0),
            exhaust_temperature_k: clamp(q(gas.exhaust.temperature_k, 100.0), 240.0, 1800.0),
        };
        let key = serde_json::to_string(&json!([lookup_rpm, cut, boundary]))
            .map_err(|e| e.to_string())?;
        let cycle = match self.online_cache.iter().find(|(k, _)| *k == key) {
            Some((_, hit)) => Arc::clone(hit),
            None => {
                let breathing_reference = if self.physical.ecu.enabled {
                    Some(efi_breathing_reference(&self.physical))
                } else {
                    None
                };
                let plant = breathing_reference
                    .as_ref()
                    .unwrap_or(self.physical.as_ref());
                let cycle = cached_legacy_cylinder_cycle(
                    &self.engine,
                    plant,
                    lookup_rpm,
                    if cut { 0.0 } else { throttle.max(0.01) },
                    Some(&boundary),
                    self.boost_fraction,
                )?;
                self.online_cache.push_back((key, Arc::clone(&cycle)));
                if self.online_cache.len() > 96 {
                    self.online_cache.pop_front();
                }
                cycle
            }
        };
        self.operating = Some(Arc::new(estimate_from_cycle(
            &self.engine,
            &self.physical,
            rpm,
            throttle,
            &cycle,
        )?));
        self.operating_cycle = Some(cycle);
        self.lookup_elapsed = 0.0;
        Ok(())
    }
    fn refresh_efi_operating(
        &mut self,
        rpm: f64,
        throttle: f64,
        state: &EcuState,
    ) -> Result<(), String> {
        self.refresh_operating(rpm, throttle)?;
        let base = Arc::clone(self.operating_cycle.as_ref().unwrap());
        let cycle = Arc::new(controlled_cycle_from_state(
            &self.engine,
            &self.physical,
            &base,
            state,
            rpm,
            "dynamic-held-cycle",
        )?);
        if cycle.released_heat_j > 1e-15 {
            self.efi_fueled_cycle = Some(Arc::clone(&cycle));
        } else {
            self.efi_fueled_cycle = None;
        }
        self.efi_base_cycle = Some(base);
        self.efi_refresh_elapsed = 0.0;
        self.operating = Some(Arc::new(estimate_from_cycle(
            &self.engine,
            &self.physical,
            rpm,
            throttle,
            &cycle,
        )?));
        self.operating_cycle = Some(cycle);
        Ok(())
    }
    fn select_efi_cycle(
        &mut self,
        rpm: f64,
        throttle: f64,
        state: &EcuState,
    ) -> Result<(), String> {
        let wants_heat = !state.combustion_cut && state.burnable_fuel_mass_flow_kgs > 1e-15;
        let currently_hot = self
            .operating_cycle
            .as_ref()
            .is_some_and(|c| c.released_heat_j > 1e-15 && c.ecu.is_some());
        if self
            .operating_cycle
            .as_ref()
            .is_none_or(|c| c.ecu.is_none())
            || self.efi_refresh_elapsed >= 0.05
        {
            return self.refresh_efi_operating(rpm, throttle, state);
        }
        if wants_heat == currently_hot {
            return Ok(());
        }
        let cycle = if wants_heat {
            if let Some(held) = &self.efi_fueled_cycle {
                Arc::clone(held)
            } else {
                let base = self
                    .efi_base_cycle
                    .as_ref()
                    .ok_or("EFI cycle has no breathing reference")?;
                let c = Arc::new(controlled_cycle_from_state(
                    &self.engine,
                    &self.physical,
                    base,
                    state,
                    rpm,
                    "dynamic-held-cycle",
                )?);
                self.efi_fueled_cycle = Some(Arc::clone(&c));
                c
            }
        } else {
            let base = self
                .efi_base_cycle
                .as_ref()
                .ok_or("EFI cycle has no breathing reference")?;
            Arc::new(controlled_cycle_from_state(
                &self.engine,
                &self.physical,
                base,
                state,
                rpm,
                "dynamic-held-cycle",
            )?)
        };
        self.operating = Some(Arc::new(estimate_from_cycle(
            &self.engine,
            &self.physical,
            rpm,
            throttle,
            &cycle,
        )?));
        self.operating_cycle = Some(cycle);
        Ok(())
    }
    fn live_efi_coupling(&self) -> Option<EcuCouplingSummary> {
        if !self.physical.ecu.enabled {
            return None;
        }
        let mut summary = self.operating.as_ref()?.ecu.clone()?;
        let state = self.ecu.get_state();
        let demanded = state.fuel_mass_per_cylinder_cycle_kg;
        let mismatch = (summary.cycle_fuel_mass_kg - demanded).abs() / demanded.max(1e-12);
        summary.demanded_cycle_fuel_mass_kg = demanded;
        summary.fuel_mass_relative_mismatch = mismatch;
        summary.fresh_air_mass_flow_kgs = state.actual_air_mass_flow_kgs;
        summary.plant_lambda = if state.delivered_fuel_mass_flow_kgs > 1e-15 {
            Some(
                state.actual_air_mass_flow_kgs
                    / (state.delivered_fuel_mass_flow_kgs * state.stoich_afr),
            )
        } else {
            None
        };
        summary.combustion_energy_scale = self.efi_audio_energy_scale(&state);
        summary.coupling_quantitatively_valid =
            summary.coupling_quantitatively_valid && state.quantitatively_valid && mismatch <= 0.05;
        if mismatch > 0.05 {
            summary.coupling_flags.push("Held pressure-cycle fuel differs from live vapor delivery by over 5%; torque is qualitative until the <=20Hz cycle refresh.".into());
        }
        summary.coupling_flags.push("EFI cycle refresh is <=20Hz per operating point; cut transitions select a cached heat-free/fueled cycle without rescaling torque.".into());
        summary.state = state;
        Some(summary)
    }
    fn efi_audio_energy_scale(&self, state: &EcuState) -> f64 {
        if state.combustion_cut || state.burnable_fuel_mass_flow_kgs <= 1e-15 {
            return 0.0;
        }
        let reference_fuel = if state.combustion_mode == CombustionMode::DirectInjectionDiesel {
            &self.physical.ecu.diesel.fuel
        } else {
            &self.physical.ecu.fuel.gasoline
        };
        let reference =
            state.actual_air_mass_flow_kgs / reference_fuel.stoich_afr * reference_fuel.lhv_jkg;
        if reference > 1e-12 {
            state.burnable_fuel_mass_flow_kgs * state.fuel_lhv_jkg / reference
        } else {
            0.0
        }
    }
    fn advance_variation(&mut self, rpm: f64, dt: f64) {
        self.cycle_progress += rpm / 120.0 * dt;
        while self.cycle_progress >= 1.0 {
            self.cycle_progress -= 1.0;
            self.cycle_index = self.cycle_index.wrapping_add(1);
            let mut bits = self.engine.seed ^ (self.cycle_index as u32).wrapping_mul(0x9e3779b1);
            let mut random = || {
                bits ^= bits << 13;
                bits ^= bits >> 17;
                bits ^= bits << 5;
                bits as f64 / 4294967296.0 * 2.0 - 1.0
            };
            let cold = clamp(
                (370.0 - self.thermal.get_state().wall_temperature_k) / 150.0,
                0.0,
                1.0,
            );
            let mixture = if self.physical.ecu.enabled {
                self.ecu
                    .get_state()
                    .true_lambda
                    .map(|lambda| clamp((lambda - 1.0).abs(), 0.0, 1.0))
                    .unwrap_or(0.0)
            } else {
                clamp((self.physical.air_fuel_ratio - 14.7).abs() / 7.0, 0.0, 1.0)
            };
            let residual = self
                .operating
                .as_ref()
                .map(|p| p.cycle.residual_fraction)
                .unwrap_or(0.0);
            let intensity = self.physical.cycle_variability
                * (0.4 + 0.3 * cold + 0.35 * mixture + 0.35 * residual);
            let joint = random() * intensity;
            let independent = random() * intensity;
            self.variation = Variation {
                energy: clamp(1.0 + joint * 0.18, 0.75, 1.2),
                duration: clamp(1.0 - joint * 0.12 + independent * 0.05, 0.8, 1.25),
                phase: clamp((-joint + independent * 0.4) * 2.0, -3.0, 3.0),
            };
        }
    }
    fn advance_turbo(&mut self, dt: f64, gas: &GasPathState) {
        let p = &self.physical;
        let e = &self.engine;
        if e.boost_bar <= 0.0 {
            self.turbo_energy_j = 0.0;
            self.boost_fraction = 0.0;
            return;
        }
        let cp = p.gamma * AIR_R / (p.gamma - 1.0);
        let ambient = p.ambient_pressure_bar * 1e5;
        let ratio = (gas.exhaust.pressure_pa / ambient).max(1.0);
        let supply = compressor_boundary(e, p, self.boost_fraction);
        let turbine = gas.outlet_mass_flow_kgs.max(0.0)
            * cp
            * gas.exhaust.temperature_k
            * (1.0 - ratio.powf(-(p.gamma - 1.0) / p.gamma))
            * p.turbine_efficiency;
        let compressor = gas.throttle_mass_flow_kgs.max(0.0)
            * cp
            * p.intake_temperature_k
            * ((supply.0 / ambient).powf((p.gamma - 1.0) / p.gamma) - 1.0)
            / p.compressor_efficiency;
        let maximum_energy = 0.5 * p.turbo_inertia_kg_m2 * 12000.0_f64.powi(2);
        let bearing_loss = 0.08 * self.turbo_energy_j;
        self.turbo_energy_j = clamp(
            self.turbo_energy_j + (turbine - compressor - bearing_loss) * dt,
            0.0,
            maximum_energy,
        );
        self.boost_fraction = if maximum_energy > 0.0 {
            (self.turbo_energy_j / maximum_energy).sqrt()
        } else {
            0.0
        };
    }
    pub fn step(
        &mut self,
        dt: f64,
        throttle: f64,
        brake: f64,
        gear: usize,
    ) -> Result<PowertrainState, String> {
        self.step_with_grade(dt, throttle, brake, gear, self.physical.grade_percent)
    }
    pub fn step_with_grade(
        &mut self,
        input_dt: f64,
        input_throttle: f64,
        input_brake: f64,
        input_gear: usize,
        input_grade: f64,
    ) -> Result<PowertrainState, String> {
        let dt = bounded(input_dt, 0.0, 0.0, 0.25);
        if dt == 0.0 {
            return Ok(self.get_state());
        }
        let p = self.physical.clone();
        let e = self.engine.clone();
        let requested = bounded(input_throttle, 0.0, 0.0, 1.0);
        let brake = bounded(input_brake, 0.0, 0.0, 1.0);
        let gear = input_gear.min(p.gear_ratios.len());
        let grade = bounded(input_grade, p.grade_percent, -20.0, 20.0);
        let steps = (dt * 240.0).ceil() as usize;
        let h = dt / steps as f64;
        let start_speed = self.speed;
        let (mut clutch, mut traction_n, mut resistance_n, mut actual_throttle, mut actual_torque) =
            (0.0, 0.0, 0.0, requested, 0.0);
        let (mut fuel_cut, mut flow_limited) = (false, false);
        let mut step_warnings: Vec<String> = vec![];
        for _ in 0..steps {
            let rpm = self.omega * 60.0 / TAU;
            let idle_error = clamp((e.idle_rpm * 1.03 - rpm) / (e.idle_rpm * 0.2), 0.0, 1.0);
            actual_throttle = if diesel_active(&p) {
                requested
            } else {
                requested.max(idle_error * 0.24)
            };
            fuel_cut = actual_throttle < 0.005 || rpm >= e.redline;
            if p.ecu.enabled {
                if self.operating.is_none() {
                    self.refresh_operating(rpm, actual_throttle)?;
                    self.efi_base_cycle = self.operating_cycle.clone();
                }
                let cycle = self.operating_cycle.as_ref().unwrap();
                let gas = self.gas.get_state();
                let boundary = GasPathBoundary {
                    intake_pressure_pa: gas.intake.pressure_pa,
                    intake_temperature_k: gas.intake.temperature_k,
                    exhaust_pressure_pa: gas.exhaust.pressure_pa,
                    exhaust_temperature_k: gas.exhaust.temperature_k,
                };
                let input = ecu_input_for(
                    &e,
                    &p.ecu,
                    rpm,
                    actual_throttle,
                    &boundary,
                    cycle.fresh_charge_mass_kg * e.cylinders as f64 * rpm / 120.0,
                    self.thermal.get_state().coolant_temperature_k,
                    cycle.as_ref(),
                    None,
                )?;
                let state = self.ecu.step(h, &input)?;
                self.select_efi_cycle(rpm, actual_throttle, &state)?;
                fuel_cut = state.combustion_cut || state.burnable_fuel_mass_flow_kgs <= 1e-15;
            } else if self
                .operating
                .as_ref()
                .is_none_or(|op| self.lookup_elapsed >= 0.05 || fuel_cut != op.fuel_cut)
            {
                self.refresh_operating(rpm, actual_throttle)?
            }
            self.advance_variation(rpm, h);
            let point = self.operating.as_ref().unwrap().clone();
            let cycle = Arc::clone(self.operating_cycle.as_ref().unwrap());
            let variation = if fuel_cut {
                1.0
            } else {
                self.variation.energy
                    * (1.0 - (self.variation.duration - 1.0) * 0.08)
                    * (1.0 - self.variation.phase.abs() * 0.002)
            };
            actual_torque = (if p.ecu.enabled {
                // EFI heat/cut was integrated inside the held pressure cycle.
                point.indicated_torque_nm * variation
            } else if fuel_cut {
                point.indicated_torque_nm.min(0.0)
            } else {
                point.indicated_torque_nm * variation
            }) - point.pumping_torque_nm
                - point.friction_torque_nm;
            let old_gas = self.gas.get_state();
            let metal = self.thermal.get_state();
            let frequency = e.cylinders as f64 * rpm / 120.0;
            let air_demand =
                (cycle.intake_mass_in_kg - cycle.intake_reverse_mass_kg).max(0.0) * frequency;
            let supply = compressor_boundary(&e, &p, self.boost_fraction);
            let mut exchange = p.thermal.exhaust_heat_transfer_effectiveness
                * old_gas.outlet_mass_flow_kgs.max(0.0)
                * p.thermal.exhaust_gas_heat_capacity_jkg_k
                * (old_gas.exhaust.temperature_k - metal.exhaust_wall_temperature_k);
            exchange = clamp(
                exchange,
                -1e6,
                1e6_f64.min(old_gas.exhaust.internal_energy_j * 0.1 / h),
            );
            let gas = self.gas.step(
                h,
                &GasPathInput {
                    rpm,
                    throttle: air_throttle_for(&p, actual_throttle),
                    engine_displacement_m3: point.geometry.displacement_m3,
                    volumetric_efficiency: point.actual_volumetric_efficiency,
                    cylinder_air_mass_flow_kgs: Some(air_demand),
                    fuel_mass_flow_kgs: Some(0.0),
                    exhaust_temperature_k: Some(cycle.exhaust_temperature_k),
                    compressor_pressure_pa: Some(supply.0),
                    compressor_temperature_k: Some(supply.1),
                    exhaust_heat_w: Some(-exchange),
                    ..GasPathInput::default()
                },
            )?;
            if gas.limited_outflow_kg > 1e-12 {
                flow_limited = true;
                let warning="Flow-limited operating point: cached torque/fueling exceeds available inventory and is invalid for quantitative power comparisons.".to_string();
                if !step_warnings.contains(&warning) {
                    step_warnings.push(warning)
                }
            }
            for warning in &gas.warnings {
                if !step_warnings.contains(warning) {
                    step_warnings.push(warning.clone())
                }
            }
            let actual_exchange = exchange - gas.limited_cooling_j / h;
            self.thermal.step(
                h,
                &ThermalLoads {
                    gas_heat_w: Some(
                        point.wall_heat_loss_w * if fuel_cut { 1.0 } else { variation },
                    ),
                    friction_heat_w: Some(point.friction_torque_nm * self.omega),
                    coupled_exhaust_gas_heat_w: Some(actual_exchange),
                    exhaust_gas_temperature_k: Some(gas.exhaust.temperature_k),
                    ..ThermalLoads::default()
                },
            )?;
            self.advance_turbo(h, &gas);
            let rho = p.ambient_pressure_bar * 1e5 / (AIR_R * 293.15);
            let slope = (grade / 100.0).atan();
            let aero = 0.5 * rho * p.drag_cd_a * self.speed.powi(2);
            let rolling = p.vehicle_mass_kg * G * p.rolling_resistance * slope.cos();
            resistance_n = aero
                + p.vehicle_mass_kg * G * slope.sin()
                + if self.speed > 0.001 { rolling } else { 0.0 };
            let brake_force = brake * p.vehicle_mass_kg * G * 0.9;
            if gear == 0 {
                clutch = 0.0;
                traction_n = 0.0;
                self.omega += actual_torque / p.engine_inertia_kg_m2 * h;
                self.speed =
                    (self.speed + (-resistance_n - brake_force) / p.vehicle_mass_kg * h).max(0.0)
            } else {
                let ratio = p.gear_ratios[gear - 1] * p.final_drive;
                let coupled_omega = self.speed / p.tyre_radius_m * ratio;
                clutch = clamp((rpm - e.idle_rpm * 1.08) / (e.idle_rpm * 0.65), 0.0, 1.0);
                let clutch_torque = passive_clutch_impulse(
                    self.omega,
                    coupled_omega / ratio,
                    ratio,
                    p.engine_inertia_kg_m2,
                    p.vehicle_mass_kg,
                    p.tyre_radius_m,
                    p.drive_efficiency,
                    clutch,
                    h,
                ) / h;
                traction_n = transmitted_wheel_torque(clutch_torque, ratio, p.drive_efficiency)
                    / p.tyre_radius_m;
                let static_rolling = if self.speed <= 0.001 && traction_n > 0.0 {
                    rolling.min(traction_n)
                } else {
                    0.0
                };
                self.speed = (self.speed
                    + (traction_n - resistance_n - brake_force - static_rolling)
                        / p.vehicle_mass_kg
                        * h)
                    .max(0.0);
                self.omega += (actual_torque - clutch_torque) / p.engine_inertia_kg_m2 * h;
            }
            self.omega = clamp(
                self.omega,
                e.idle_rpm * TAU / 60.0,
                e.redline * 1.04 * TAU / 60.0,
            );
            self.speed = self.speed.min(150.0);
            self.lookup_elapsed += h;
            if p.ecu.enabled {
                self.efi_refresh_elapsed += h;
            }
        }
        let rpm = self.omega * 60.0 / TAU;
        let physical = self.audio_state(fuel_cut);
        let gas_path = self.gas.get_state();
        let load = clamp(
            gas_path.intake.pressure_pa
                / ((p.ambient_pressure_bar + e.boost_bar * self.boost_fraction) * 1e5),
            0.0,
            1.0,
        );
        let mut warnings = self
            .operating
            .as_ref()
            .map(|op| op.warnings.clone())
            .unwrap_or_default();
        for warning in step_warnings {
            if !warnings.contains(&warning) {
                warnings.push(warning)
            }
        }
        for warning in [
            "Online cycle lookup: 500rpm / 0.1bar / 25K intake / 100K exhaust bins, held at up to20Hz; reference cylinder wall temperature is not dynamically refitted.",
            "Mean gas inventories close their own ledgers; cached cylinder/shaft and air-standard fuel approximations do not establish a whole-engine energy closure.",
        ] {
            if !warnings.iter().any(|w| w == warning) {
                warnings.push(warning.into())
            }
        }
        let efi_coupling = self.live_efi_coupling();
        if let Some(summary) = &efi_coupling {
            for flag in &summary.coupling_flags {
                if !warnings.contains(flag) {
                    warnings.push(flag.clone());
                }
            }
        }
        self.last = Some(PowertrainState {
            rpm,
            load,
            throttle: actual_throttle,
            speed_ms: self.speed,
            speed_kmh: self.speed * 3.6,
            acceleration_ms2: (self.speed - start_speed) / dt,
            gear: gear as f64,
            clutch,
            torque_nm: actual_torque,
            power_kw: actual_torque * self.omega / 1000.0,
            resistance_n,
            traction_n,
            boost_fraction: self.boost_fraction,
            quantitatively_valid: !flow_limited
                && efi_coupling
                    .as_ref()
                    .is_none_or(|s| s.coupling_quantitatively_valid)
                && self.operating.as_ref().is_some_and(|op| {
                    op.cycle.periodic_mass_relative_error <= 0.02
                        && op.cycle.periodic_energy_relative_error <= 0.02
                }),
            physical_audio: physical.clone(),
            physical,
            gas_path,
            thermal: self.thermal.get_state(),
            warnings,
            ecu: if self.physical.ecu.enabled {
                Some(self.ecu.get_state())
            } else {
                None
            },
            ecu_coupling: efi_coupling,
        });
        Ok(self.get_state())
    }
}
