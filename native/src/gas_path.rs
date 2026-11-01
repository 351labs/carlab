//! Faithful f64 port of the original v4 mean ideal-gas air path.
//! All pressure is absolute Pa; temperatures K, mass kg, energy J.
use serde::{Deserialize, Serialize};
use serde_json::Value;

fn bounded(v: f64, fallback: f64, lo: f64, hi: f64) -> f64 {
    if v.is_finite() {
        v.clamp(lo, hi)
    } else {
        fallback
    }
}
fn number(v: &Value, k: &str, d: f64, lo: f64, hi: f64) -> f64 {
    bounded(v.get(k).and_then(Value::as_f64).unwrap_or(d), d, lo, hi)
}
fn positive(v: f64, name: &str) -> Result<f64, String> {
    if v.is_finite() && v > 0.0 {
        Ok(v)
    } else {
        Err(format!("{name} must be finite and positive"))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct GasPathConfig {
    pub ambient_pressure_pa: f64,
    pub ambient_temperature_k: f64,
    pub intake_volume_m3: f64,
    pub exhaust_volume_m3: f64,
    pub throttle_diameter_m: f64,
    pub throttle_discharge: f64,
    pub throttle_leak_fraction: f64,
    pub exhaust_diameter_m: f64,
    pub exhaust_length_m: f64,
    pub exhaust_minor_k: f64,
    pub exhaust_friction_factor: f64,
    pub gamma: f64,
    pub gas_constant: f64,
}
impl Default for GasPathConfig {
    fn default() -> Self {
        Self {
            ambient_pressure_pa: 101325.0,
            ambient_temperature_k: 293.15,
            intake_volume_m3: 0.003,
            exhaust_volume_m3: 0.003,
            throttle_diameter_m: 0.05,
            throttle_discharge: 0.72,
            throttle_leak_fraction: 0.01,
            exhaust_diameter_m: 0.06,
            exhaust_length_m: 1.7,
            exhaust_minor_k: 2.0,
            exhaust_friction_factor: 0.025,
            gamma: 1.35,
            gas_constant: 287.05,
        }
    }
}
impl GasPathConfig {
    pub fn normalize(input: &Value) -> Self {
        normalize_gas_path_config(input)
    }
    fn normalized(&self) -> Self {
        let mut c = self.clone();
        macro_rules! bound {
            ($field:ident,$default:expr,$lo:expr,$hi:expr) => {
                c.$field = bounded(c.$field, $default, $lo, $hi);
            };
        }
        bound!(ambient_pressure_pa, 101325.0, 30000.0, 200000.0);
        bound!(ambient_temperature_k, 293.15, 200.0, 500.0);
        bound!(intake_volume_m3, 0.003, 0.0002, 0.2);
        bound!(exhaust_volume_m3, 0.003, 0.0002, 0.2);
        bound!(throttle_diameter_m, 0.05, 0.005, 0.2);
        bound!(throttle_discharge, 0.72, 0.1, 1.0);
        bound!(throttle_leak_fraction, 0.01, 0.0, 0.2);
        bound!(exhaust_diameter_m, 0.06, 0.01, 0.2);
        bound!(exhaust_length_m, 1.7, 0.0, 10.0);
        bound!(exhaust_minor_k, 2.0, 0.0, 100.0);
        bound!(exhaust_friction_factor, 0.025, 0.0, 0.15);
        bound!(gamma, 1.35, 1.1, 1.67);
        bound!(gas_constant, 287.05, 200.0, 500.0);
        c
    }
}
pub fn normalize_gas_path_config(v: &Value) -> GasPathConfig {
    GasPathConfig {
        ambient_pressure_pa: number(v, "ambientPressurePa", 101325.0, 30000.0, 200000.0),
        ambient_temperature_k: number(v, "ambientTemperatureK", 293.15, 200.0, 500.0),
        intake_volume_m3: number(v, "intakeVolumeM3", 0.003, 0.0002, 0.2),
        exhaust_volume_m3: number(v, "exhaustVolumeM3", 0.003, 0.0002, 0.2),
        throttle_diameter_m: number(v, "throttleDiameterM", 0.05, 0.005, 0.2),
        throttle_discharge: number(v, "throttleDischarge", 0.72, 0.1, 1.0),
        throttle_leak_fraction: number(v, "throttleLeakFraction", 0.01, 0.0, 0.2),
        exhaust_diameter_m: number(v, "exhaustDiameterM", 0.06, 0.01, 0.2),
        exhaust_length_m: number(v, "exhaustLengthM", 1.7, 0.0, 10.0),
        exhaust_minor_k: number(v, "exhaustMinorK", 2.0, 0.0, 100.0),
        exhaust_friction_factor: number(v, "exhaustFrictionFactor", 0.025, 0.0, 0.15),
        gamma: number(v, "gamma", 1.35, 1.1, 1.67),
        gas_constant: number(v, "gasConstant", 287.05, 200.0, 500.0),
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReservoirState {
    pub mass_kg: f64,
    pub internal_energy_j: f64,
    pub pressure_pa: f64,
    pub temperature_k: f64,
    pub volume_m3: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReservoirInflow {
    pub mass_flow_kgs: f64,
    pub temperature_k: f64,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReservoirBalance {
    pub mass_in_kg: f64,
    pub mass_out_kg: f64,
    pub energy_in_j: f64,
    pub energy_out_j: f64,
    pub heat_j: f64,
    pub limited_outflow_kg: f64,
    pub limited_cooling_j: f64,
    pub mass_residual_kg: f64,
    pub energy_residual_j: f64,
}

/// Positive means A→B; reverse flow selects the opposite upstream temperature.
pub fn compressible_orifice_flow(
    pressure_a_pa: f64,
    temperature_a_k: f64,
    pressure_b_pa: f64,
    temperature_b_k: f64,
    area_m2: f64,
    discharge: f64,
    gamma: f64,
    gas_constant: f64,
) -> Result<f64, String> {
    positive(pressure_a_pa, "pressure A")?;
    positive(pressure_b_pa, "pressure B")?;
    positive(temperature_a_k, "temperature A")?;
    positive(temperature_b_k, "temperature B")?;
    if !area_m2.is_finite()
        || area_m2 < 0.0
        || !discharge.is_finite()
        || !(0.0..=1.0).contains(&discharge)
        || !gamma.is_finite()
        || gamma <= 1.0
        || !gas_constant.is_finite()
        || gas_constant <= 0.0
    {
        return Err("Invalid orifice parameters".into());
    }
    if area_m2 == 0.0 || discharge == 0.0 || pressure_a_pa == pressure_b_pa {
        return Ok(0.0);
    }
    let sign = if pressure_a_pa > pressure_b_pa {
        1.0
    } else {
        -1.0
    };
    let (up, down, temp) = if sign > 0.0 {
        (pressure_a_pa, pressure_b_pa, temperature_a_k)
    } else {
        (pressure_b_pa, pressure_a_pa, temperature_b_k)
    };
    let ratio = down / up;
    let critical = (2.0 / (gamma + 1.0)).powf(gamma / (gamma - 1.0));
    let factor = if ratio <= critical {
        gamma.sqrt() * (2.0 / (gamma + 1.0)).powf((gamma + 1.0) / (2.0 * (gamma - 1.0)))
    } else {
        (2.0 * gamma / (gamma - 1.0)
            * (ratio.powf(2.0 / gamma) - ratio.powf((gamma + 1.0) / gamma)))
        .max(0.0)
        .sqrt()
    };
    Ok(sign * discharge * area_m2 * up / (gas_constant * temp).sqrt() * factor)
}
pub fn exhaust_pressure_loss(
    mass_flow_kgs: f64,
    density_kgm3: f64,
    diameter_m: f64,
    length_m: f64,
    minor_k: f64,
    friction_factor: f64,
) -> Result<f64, String> {
    positive(density_kgm3, "density")?;
    positive(diameter_m, "diameter")?;
    if !mass_flow_kgs.is_finite()
        || !length_m.is_finite()
        || length_m < 0.0
        || !minor_k.is_finite()
        || minor_k < 0.0
        || !friction_factor.is_finite()
        || friction_factor < 0.0
    {
        return Err("Invalid pressure-loss parameters".into());
    }
    let area = std::f64::consts::PI * diameter_m.powi(2) / 4.0;
    let k = 1.0 + minor_k + friction_factor * length_m / diameter_m;
    Ok(k * mass_flow_kgs * mass_flow_kgs.abs() / (2.0 * density_kgm3 * area.powi(2)))
}

#[derive(Clone, Debug)]
pub struct IdealGasReservoir {
    mass: f64,
    energy: f64,
    pub volume_m3: f64,
    pub gamma: f64,
    pub gas_constant: f64,
    pub cv: f64,
    pub cp: f64,
}
impl IdealGasReservoir {
    pub fn new(
        volume_m3: f64,
        pressure_pa: f64,
        temperature_k: f64,
        gamma: f64,
        gas_constant: f64,
    ) -> Result<Self, String> {
        positive(volume_m3, "volume")?;
        positive(pressure_pa, "pressure")?;
        positive(temperature_k, "temperature")?;
        positive(gas_constant, "gas constant")?;
        if !gamma.is_finite() || !(1.1..=1.67).contains(&gamma) {
            return Err("Reservoir gamma must be within the supported1.1–1.67 domain".into());
        }
        let cv = gas_constant / (gamma - 1.0);
        let mass = pressure_pa * volume_m3 / (gas_constant * temperature_k);
        let energy = mass * cv * temperature_k;
        if !mass.is_finite() || !energy.is_finite() || mass <= 0.0 || energy <= 0.0 {
            return Err("Gas inventory is outside the finite positive numeric domain".into());
        }
        Ok(Self {
            mass,
            energy,
            volume_m3,
            gamma,
            gas_constant,
            cv,
            cp: cv + gas_constant,
        })
    }
    pub fn get_state(&self) -> ReservoirState {
        let temperature_k = self.energy / (self.mass * self.cv);
        ReservoirState {
            mass_kg: self.mass,
            internal_energy_j: self.energy,
            temperature_k,
            pressure_pa: self.mass * self.gas_constant * temperature_k / self.volume_m3,
            volume_m3: self.volume_m3,
        }
    }
    pub fn advance(
        &mut self,
        dt: f64,
        inflows: &[ReservoirInflow],
        outflow_kgs: f64,
        heat_w: f64,
    ) -> Result<ReservoirBalance, String> {
        if !dt.is_finite()
            || dt < 0.0
            || !outflow_kgs.is_finite()
            || outflow_kgs < 0.0
            || !heat_w.is_finite()
        {
            return Err("Invalid reservoir flow/step".into());
        }
        let before_mass = self.mass;
        let before_energy = self.energy;
        let temperature = self.get_state().temperature_k;
        let (mut mass_in_kg, mut energy_in_j) = (0.0, 0.0);
        for flow in inflows {
            if !flow.mass_flow_kgs.is_finite() || flow.mass_flow_kgs < 0.0 {
                return Err("Invalid inflow".into());
            }
            positive(flow.temperature_k, "inlet temperature")?;
            let dm = flow.mass_flow_kgs * dt;
            mass_in_kg += dm;
            energy_in_j += dm * self.cp * flow.temperature_k;
        }
        let requested_out = outflow_kgs * dt;
        let mass_out_kg = requested_out.min(self.mass * 0.2);
        let energy_out_j = mass_out_kg * self.cp * temperature;
        let before_heat = self.energy + energy_in_j - energy_out_j;
        let requested_heat = heat_w * dt;
        let heat_j = requested_heat.max(-before_heat * 0.95);
        self.mass += mass_in_kg - mass_out_kg;
        self.energy = before_heat + heat_j;
        if !self.mass.is_finite()
            || !self.energy.is_finite()
            || self.mass <= 0.0
            || self.energy <= 0.0
        {
            return Err("Gas reservoir left its positive finite domain".into());
        }
        Ok(ReservoirBalance {
            mass_in_kg,
            mass_out_kg,
            energy_in_j,
            energy_out_j,
            heat_j,
            limited_outflow_kg: requested_out - mass_out_kg,
            limited_cooling_j: heat_j - requested_heat,
            mass_residual_kg: self.mass - before_mass - (mass_in_kg - mass_out_kg),
            energy_residual_j: self.energy - before_energy - (energy_in_j - energy_out_j + heat_j),
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GasPathInput {
    pub rpm: f64,
    pub throttle: f64,
    pub engine_displacement_m3: f64,
    pub volumetric_efficiency: f64,
    pub fuel_mass_flow_kgs: Option<f64>,
    pub exhaust_temperature_k: Option<f64>,
    pub compressor_pressure_pa: Option<f64>,
    pub compressor_temperature_k: Option<f64>,
    pub cylinder_air_mass_flow_kgs: Option<f64>,
    pub intake_heat_w: Option<f64>,
    pub exhaust_heat_w: Option<f64>,
}
impl Default for GasPathInput {
    fn default() -> Self {
        Self {
            rpm: 0.0,
            throttle: 0.0,
            engine_displacement_m3: 0.002,
            volumetric_efficiency: 0.9,
            fuel_mass_flow_kgs: None,
            exhaust_temperature_k: None,
            compressor_pressure_pa: None,
            compressor_temperature_k: None,
            cylinder_air_mass_flow_kgs: None,
            intake_heat_w: None,
            exhaust_heat_w: None,
        }
    }
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GasPathReset {
    pub intake_pressure_pa: Option<f64>,
    pub intake_temperature_k: Option<f64>,
    pub exhaust_pressure_pa: Option<f64>,
    pub exhaust_temperature_k: Option<f64>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GasPathState {
    pub intake: ReservoirState,
    pub exhaust: ReservoirState,
    pub throttle_mass_flow_kgs: f64,
    pub cylinder_air_mass_flow_kgs: f64,
    pub cylinder_exhaust_mass_flow_kgs: f64,
    pub fuel_mass_flow_kgs: f64,
    pub outlet_mass_flow_kgs: f64,
    pub exhaust_pressure_loss_pa: f64,
    pub mass_balance_residual_kg: f64,
    pub energy_balance_residual_j: f64,
    pub intake_heat_j: f64,
    pub exhaust_heat_j: f64,
    pub limited_outflow_kg: f64,
    pub limited_cooling_j: f64,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct GasPath {
    config: GasPathConfig,
    intake: IdealGasReservoir,
    exhaust: IdealGasReservoir,
    last: GasPathState,
}
impl GasPath {
    pub fn new(config: GasPathConfig) -> Result<Self, String> {
        let c = config.normalized();
        let intake = IdealGasReservoir::new(
            c.intake_volume_m3,
            c.ambient_pressure_pa,
            c.ambient_temperature_k,
            c.gamma,
            c.gas_constant,
        )?;
        let exhaust = IdealGasReservoir::new(
            c.exhaust_volume_m3,
            c.ambient_pressure_pa,
            550.0,
            c.gamma,
            c.gas_constant,
        )?;
        let mut path = Self {
            config: c,
            intake,
            exhaust,
            last: GasPathState::default(),
        };
        path.last = path.empty_state();
        Ok(path)
    }
    fn empty_state(&self) -> GasPathState {
        GasPathState {
            intake: self.intake.get_state(),
            exhaust: self.exhaust.get_state(),
            ..GasPathState::default()
        }
    }
    pub fn configure(&mut self, input: GasPathConfig) -> Result<(), String> {
        let old = self.config.clone();
        let next = input.normalized();
        self.config = next.clone();
        if old.intake_volume_m3 != next.intake_volume_m3
            || old.exhaust_volume_m3 != next.exhaust_volume_m3
            || old.gamma != next.gamma
            || old.gas_constant != next.gas_constant
        {
            let a = self.intake.get_state();
            let e = self.exhaust.get_state();
            self.reset(GasPathReset {
                intake_pressure_pa: Some(a.pressure_pa),
                intake_temperature_k: Some(a.temperature_k),
                exhaust_pressure_pa: Some(e.pressure_pa),
                exhaust_temperature_k: Some(e.temperature_k),
            })?;
            self.last.warnings.push(
                "Gas inventory reset after volume/gas-property configuration changed.".into(),
            );
        }
        Ok(())
    }
    pub fn reset(&mut self, s: GasPathReset) -> Result<GasPathState, String> {
        let c = &self.config;
        self.intake = IdealGasReservoir::new(
            c.intake_volume_m3,
            bounded(
                s.intake_pressure_pa.unwrap_or(c.ambient_pressure_pa),
                c.ambient_pressure_pa,
                1000.0,
                2e6,
            ),
            bounded(
                s.intake_temperature_k.unwrap_or(c.ambient_temperature_k),
                c.ambient_temperature_k,
                100.0,
                3000.0,
            ),
            c.gamma,
            c.gas_constant,
        )?;
        self.exhaust = IdealGasReservoir::new(
            c.exhaust_volume_m3,
            bounded(
                s.exhaust_pressure_pa.unwrap_or(c.ambient_pressure_pa),
                c.ambient_pressure_pa,
                1000.0,
                2e6,
            ),
            bounded(
                s.exhaust_temperature_k.unwrap_or(550.0),
                550.0,
                100.0,
                3000.0,
            ),
            c.gamma,
            c.gas_constant,
        )?;
        self.last = self.empty_state();
        Ok(self.get_state())
    }
    pub fn get_state(&self) -> GasPathState {
        self.last.clone()
    }
    pub fn step(&mut self, input_dt: f64, input: &GasPathInput) -> Result<GasPathState, String> {
        let dt = bounded(input_dt, 0.0, 0.0, 0.25);
        if dt == 0.0 {
            return Ok(self.get_state());
        }
        let c = self.config.clone();
        let steps = (dt / 0.0005).ceil() as usize;
        let h = dt / steps as f64;
        let throttle = bounded(input.throttle, 0.0, 0.0, 1.0);
        let rpm = bounded(input.rpm, 0.0, 0.0, 22000.0);
        let displacement = bounded(input.engine_displacement_m3, 0.002, 0.00001, 0.03);
        let ve = bounded(input.volumetric_efficiency, 0.9, 0.0, 2.0);
        let supply_pressure = bounded(
            input
                .compressor_pressure_pa
                .unwrap_or(c.ambient_pressure_pa),
            c.ambient_pressure_pa,
            1000.0,
            2e6,
        );
        let supply_temp = bounded(
            input
                .compressor_temperature_k
                .unwrap_or(c.ambient_temperature_k),
            c.ambient_temperature_k,
            100.0,
            2000.0,
        );
        let exhaust_temp = bounded(
            input.exhaust_temperature_k.unwrap_or(800.0),
            800.0,
            150.0,
            3000.0,
        );
        let fuel_demand = bounded(input.fuel_mass_flow_kgs.unwrap_or(0.0), 0.0, 0.0, 0.5);
        let throttle_area = std::f64::consts::PI * c.throttle_diameter_m.powi(2) / 4.0
            * (c.throttle_leak_fraction + (1.0 - c.throttle_leak_fraction) * throttle.powi(2));
        let exit_area = std::f64::consts::PI * c.exhaust_diameter_m.powi(2) / 4.0;
        let exit_k = 1.0
            + c.exhaust_minor_k
            + c.exhaust_friction_factor * c.exhaust_length_m / c.exhaust_diameter_m;
        let (
            mut throttle_mass,
            mut cylinder_air,
            mut cylinder_exhaust,
            mut fuel_mass,
            mut outlet_mass,
            mut mass_residual,
            mut energy_residual,
            mut intake_heat,
            mut exhaust_heat,
            mut limited_outflow,
            mut limited_cooling,
        ) = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
        for _ in 0..steps {
            let a = self.intake.get_state();
            let e = self.exhaust.get_state();
            let throttle_flow = compressible_orifice_flow(
                supply_pressure,
                supply_temp,
                a.pressure_pa,
                a.temperature_k,
                throttle_area,
                c.throttle_discharge,
                c.gamma,
                c.gas_constant,
            )?;
            let requested_air = if let Some(flow) = input.cylinder_air_mass_flow_kgs {
                bounded(flow, 0.0, 0.0, 5.0)
            } else {
                a.mass_kg / c.intake_volume_m3 * ve * displacement * rpm / 120.0
            };
            let intake_out = requested_air + (-throttle_flow).max(0.0);
            let inflow = [ReservoirInflow {
                mass_flow_kgs: throttle_flow.max(0.0),
                temperature_k: supply_temp,
            }];
            let inflows = if throttle_flow > 0.0 {
                &inflow[..]
            } else {
                &inflow[..0]
            };
            let ib = self.intake.advance(
                h,
                inflows,
                intake_out,
                bounded(input.intake_heat_w.unwrap_or(0.0), 0.0, -1e6, 1e6),
            )?;
            let out_ratio = if intake_out > 0.0 {
                ib.mass_out_kg / (intake_out * h)
            } else {
                1.0
            };
            let actual_air = requested_air * out_ratio;
            let actual_throttle = if throttle_flow >= 0.0 {
                throttle_flow
            } else {
                throttle_flow * out_ratio
            };
            let actual_fuel = fuel_demand * if requested_air > 0.0 { out_ratio } else { 0.0 };
            let exhaust_in = actual_air + actual_fuel;
            let outlet_flow = compressible_orifice_flow(
                e.pressure_pa,
                e.temperature_k,
                c.ambient_pressure_pa,
                c.ambient_temperature_k,
                exit_area,
                1.0 / exit_k.sqrt(),
                c.gamma,
                c.gas_constant,
            )?;
            let inflows = [
                ReservoirInflow {
                    mass_flow_kgs: exhaust_in,
                    temperature_k: exhaust_temp,
                },
                ReservoirInflow {
                    mass_flow_kgs: (-outlet_flow).max(0.0),
                    temperature_k: c.ambient_temperature_k,
                },
            ];
            let count = if outlet_flow < 0.0 { 2 } else { 1 };
            let eb = self.exhaust.advance(
                h,
                &inflows[..count],
                outlet_flow.max(0.0),
                bounded(input.exhaust_heat_w.unwrap_or(0.0), 0.0, -1e6, 1e6),
            )?;
            let actual_outlet = if outlet_flow <= 0.0 {
                outlet_flow
            } else {
                eb.mass_out_kg / h
            };
            throttle_mass += actual_throttle * h;
            cylinder_air += actual_air * h;
            cylinder_exhaust += exhaust_in * h;
            fuel_mass += actual_fuel * h;
            outlet_mass += actual_outlet * h;
            mass_residual += ib.mass_residual_kg + eb.mass_residual_kg;
            energy_residual += ib.energy_residual_j + eb.energy_residual_j;
            intake_heat += ib.heat_j;
            exhaust_heat += eb.heat_j;
            limited_outflow += ib.limited_outflow_kg + eb.limited_outflow_kg;
            limited_cooling += ib.limited_cooling_j + eb.limited_cooling_j;
        }
        let intake = self.intake.get_state();
        let exhaust = self.exhaust.get_state();
        let outlet_mass_flow_kgs = outlet_mass / dt;
        let mut warnings = vec![];
        if limited_outflow > 1e-12 {
            warnings.push("Explicit gas outflow limited by available inventory; refine step or review volumes/flows.".into());
        }
        if limited_cooling > 1e-8 {
            warnings.push("Cooling limited to retain positive gas energy; thermal inputs outside the explicit-step domain.".into());
        }
        let exhaust_pressure_loss_pa = exhaust_pressure_loss(
            outlet_mass_flow_kgs,
            exhaust.mass_kg / c.exhaust_volume_m3,
            c.exhaust_diameter_m,
            c.exhaust_length_m,
            c.exhaust_minor_k,
            c.exhaust_friction_factor,
        )?;
        self.last = GasPathState {
            intake,
            exhaust,
            throttle_mass_flow_kgs: throttle_mass / dt,
            cylinder_air_mass_flow_kgs: cylinder_air / dt,
            cylinder_exhaust_mass_flow_kgs: cylinder_exhaust / dt,
            fuel_mass_flow_kgs: fuel_mass / dt,
            outlet_mass_flow_kgs,
            exhaust_pressure_loss_pa,
            mass_balance_residual_kg: mass_residual,
            energy_balance_residual_j: energy_residual,
            intake_heat_j: intake_heat,
            exhaust_heat_j: exhaust_heat,
            limited_outflow_kg: limited_outflow,
            limited_cooling_j: limited_cooling,
            warnings,
        };
        Ok(self.get_state())
    }
}
