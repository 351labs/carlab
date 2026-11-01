//! Original reduced PFI controller and fuel-delivery model. Plant air truth is
//! used only for mixture/oxygen accounting and observation, never feedforward.
//! This is a mass-ratio lambda proxy, not an oxygen-chemistry/real-ECU model.
use crate::config::EngineConfig;
use crate::maps::{AxisUnits, CalibrationProvenance, normalize_provenance};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::VecDeque;

const AIR_R:f64=287.05;
const MAP_SCHEMA:&str="carlab-ecu-map-1";
#[derive(Clone,Copy,Debug,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub enum EcuMapKind{LambdaTarget,FuelCorrection,SparkAdvance,VeEstimate,DieselFuelQuantity,DieselMinimumLambda,DieselInjectionAdvance}
impl EcuMapKind{
    fn spec(self)->(&'static str,f64,f64){match self{Self::LambdaTarget=>("lambda",0.65,1.4),Self::FuelCorrection=>("multiplier",0.25,4.0),Self::SparkAdvance=>("degBTDC",-10.0,50.0),Self::VeEstimate=>("fraction",0.1,1.5),Self::DieselFuelQuantity=>("mgPerCylinderCycle",0.0,500.0),Self::DieselMinimumLambda=>("lambda",1.0,4.0),Self::DieselInjectionAdvance=>("degBTDC",-10.0,40.0)}}
}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct EcuMap{
    pub schema:String,pub kind:EcuMapKind,pub rpm:Vec<f64>,pub pressure_bar:Vec<f64>,
    pub values:Vec<Vec<f64>>,pub axis_units:AxisUnits,pub value_unit:String,
    pub provenance:CalibrationProvenance,pub extrapolation:String,
}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct EcuMapSample{pub value:f64,pub extrapolated:bool,pub extrapolated_axes:Vec<String>,pub clamped_rpm:f64,pub clamped_pressure_bar:f64}
fn axis(values:&[f64],label:&str,lo:f64,hi:f64)->Result<(),String>{
    if values.len()<2||values.len()>32||values.iter().enumerate().any(|(i,v)|!v.is_finite()||*v<lo||*v>hi||(i>0&&*v<=values[i-1])){return Err(format!("{label} requires 2..32 finite strictly increasing values in {lo}..{hi}."))}Ok(())
}
fn bracket(values:&[f64],x:f64)->(usize,f64){let mut i=0;while i+2<values.len()&&values[i+1]<x{i+=1}(i,(x-values[i])/(values[i+1]-values[i]))}
fn bilinear(x:&[f64],y:&[f64],grid:&[Vec<f64>],query_x:f64,query_y:f64)->f64{
    let (i,a)=bracket(x,query_x);let(j,b)=bracket(y,query_y);
    let low=grid[i][j]+(grid[i+1][j]-grid[i][j])*a;
    let high=grid[i][j+1]+(grid[i+1][j+1]-grid[i][j+1])*a;
    low+(high-low)*b
}
fn checked(n:f64,label:&str,lo:f64,hi:f64)->Result<(),String>{if !n.is_finite()||n<lo||n>hi{Err(format!("{label} must be finite in {lo}..{hi}."))}else{Ok(())}}
fn provenance(p:&CalibrationProvenance)->Result<(),String>{normalize_provenance(&serde_json::to_value(p).map_err(|e|e.to_string())?).map(|_|())}
fn assumed(label:&str)->CalibrationProvenance{CalibrationProvenance{source:"assumed".into(),label:label.into(),version:"original-efi-demo-1".into(),engine_id:None,notes:Some("Synthetic demonstration assumptions; not a measured injector or engine tune.".into()),calibrated_at:None,validation:None}}
impl EcuMap{
    pub fn from_value(input:&Value,kind:EcuMapKind)->Result<Self,String>{let result:Self=serde_json::from_value(input.clone()).map_err(|e|format!("Invalid ECU map: {e}"))?;if result.kind!=kind{return Err("ECU map kind does not match its slot.".into())}result.validate()?;Ok(result)}
    pub fn validate(&self)->Result<(),String>{
        if self.schema!=MAP_SCHEMA||self.extrapolation!="clamp"||self.axis_units.rpm!="rpm"||self.axis_units.pressure!="bar-absolute"{return Err("Invalid ECU map schema, axis units or extrapolation policy.".into())}
        let(unit,lo,hi)=self.kind.spec();if self.value_unit!=unit{return Err("Invalid ECU map value unit.".into())}
        axis(&self.rpm,"ECU RPM axis",100.0,30000.0)?;axis(&self.pressure_bar,"ECU absolute-MAP axis",0.01,10.0)?;
        if self.values.len()!=self.rpm.len()||self.values.iter().any(|r|r.len()!=self.pressure_bar.len()||r.iter().any(|v|!v.is_finite()||*v<lo||*v>hi)){return Err("Invalid ECU map grid or value domain.".into())}provenance(&self.provenance)
    }
    pub fn sample(&self,rpm:f64,pressure_bar:f64)->Result<EcuMapSample,String>{
        self.validate()?;self.sample_validated(rpm,pressure_bar)
    }
    fn sample_validated(&self,rpm:f64,pressure_bar:f64)->Result<EcuMapSample,String>{
        if !rpm.is_finite()||!pressure_bar.is_finite(){return Err("ECU map query must be finite.".into())}
        let r=rpm.clamp(self.rpm[0],*self.rpm.last().unwrap());let p=pressure_bar.clamp(self.pressure_bar[0],*self.pressure_bar.last().unwrap());
        let mut axes=Vec::new();if r!=rpm{axes.push("rpm".into())}if p!=pressure_bar{axes.push("pressureBar".into())}
        Ok(EcuMapSample{value:bilinear(&self.rpm,&self.pressure_bar,&self.values,r,p),extrapolated:!axes.is_empty(),extrapolated_axes:axes,clamped_rpm:r,clamped_pressure_bar:p})
    }
    pub fn constant_for(engine:&EngineConfig,kind:EcuMapKind,value:f64)->Self{let(unit,_,_)=kind.spec();Self{schema:MAP_SCHEMA.into(),kind,rpm:vec![engine.idle_rpm.min(engine.redline-1.0).max(100.0),engine.redline.max(engine.idle_rpm+1.0)],pressure_bar:vec![0.1,(1.3+engine.boost_bar).max(1.3)],values:vec![vec![value;2];2],axis_units:AxisUnits{rpm:"rpm".into(),pressure:"bar-absolute".into()},value_unit:unit.into(),provenance:assumed("Original synthetic EFI grid"),extrapolation:"clamp".into()}}
}
pub fn normalize_ecu_map(input:&Value,kind:EcuMapKind)->Result<EcuMap,String>{EcuMap::from_value(input,kind)}
pub fn sample_ecu_map(map:&EcuMap,rpm:f64,pressure_bar:f64)->Result<EcuMapSample,String>{map.sample(rpm,pressure_bar)}

#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct FuelComponent{pub density_kg_m3:f64,pub stoich_afr:f64,pub lhv_jkg:f64,pub provenance:CalibrationProvenance}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct FuelBlendConfig{pub ethanol_volume_fraction:f64,pub gasoline:FuelComponent,pub ethanol:FuelComponent}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct FuelBlendProperties{pub ethanol_volume_fraction:f64,pub ethanol_mass_fraction:f64,pub density_kg_m3:f64,pub stoich_afr:f64,pub lhv_jkg:f64,pub status:String}
impl FuelBlendConfig{
    pub fn validate(&self)->Result<(),String>{checked(self.ethanol_volume_fraction,"Ethanol volume fraction",0.0,1.0)?;for c in [&self.gasoline,&self.ethanol]{checked(c.density_kg_m3,"Fuel density kg/m3",400.0,1200.0)?;checked(c.stoich_afr,"Fuel stoichiometric AFR",2.0,25.0)?;checked(c.lhv_jkg,"Fuel LHV J/kg",1e6,60e6)?;provenance(&c.provenance)?}Ok(())}
}
fn properties_from_mass_fraction(config:&FuelBlendConfig,w:f64)->FuelBlendProperties{
    let w=w.clamp(0.0,1.0);let volume=w/config.ethanol.density_kg_m3+(1.0-w)/config.gasoline.density_kg_m3;
    FuelBlendProperties{ethanol_volume_fraction:(w/config.ethanol.density_kg_m3)/volume,ethanol_mass_fraction:w,density_kg_m3:1.0/volume,stoich_afr:w*config.ethanol.stoich_afr+(1.0-w)*config.gasoline.stoich_afr,lhv_jkg:w*config.ethanol.lhv_jkg+(1.0-w)*config.gasoline.lhv_jkg,status:"assumed-additive-volume-mixture".into()}
}
pub fn fuel_blend_properties(config:&FuelBlendConfig)->Result<FuelBlendProperties,String>{config.validate()?;Ok(feed_properties(config))}
fn feed_properties(config:&FuelBlendConfig)->FuelBlendProperties{let v=config.ethanol_volume_fraction;let density=v*config.ethanol.density_kg_m3+(1.0-v)*config.gasoline.density_kg_m3;properties_from_mass_fraction(config,v*config.ethanol.density_kg_m3/density)}

#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct InjectorDeadTimeMap{pub voltage_v:Vec<f64>,pub delta_pressure_bar:Vec<f64>,pub values_ms:Vec<Vec<f64>>,pub provenance:CalibrationProvenance}
impl InjectorDeadTimeMap{
    pub fn validate(&self)->Result<(),String>{axis(&self.voltage_v,"Injector voltage axis",4.0,24.0)?;axis(&self.delta_pressure_bar,"Injector differential-pressure axis",0.01,3000.0)?;if self.values_ms.len()!=self.voltage_v.len()||self.values_ms.iter().any(|r|r.len()!=self.delta_pressure_bar.len()||r.iter().any(|v|!v.is_finite()||*v<0.0||*v>10.0)){return Err("Invalid injector dead-time grid.".into())}provenance(&self.provenance)}
    pub fn sample(&self,voltage:f64,delta_pressure_bar:f64)->Result<(f64,bool),String>{self.validate()?;self.sample_validated(voltage,delta_pressure_bar)}
    fn sample_validated(&self,voltage:f64,delta_pressure_bar:f64)->Result<(f64,bool),String>{if !voltage.is_finite()||!delta_pressure_bar.is_finite(){return Err("Injector dead-time query must be finite.".into())}let v=voltage.clamp(self.voltage_v[0],*self.voltage_v.last().unwrap());let p=delta_pressure_bar.clamp(self.delta_pressure_bar[0],*self.delta_pressure_bar.last().unwrap());Ok((bilinear(&self.voltage_v,&self.delta_pressure_bar,&self.values_ms,v,p),v!=voltage||p!=delta_pressure_bar))}
}
#[derive(Clone,Copy,Debug,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub enum InjectorRailMode{MapReferenced,FixedAbsolute}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct InjectorConfig{
    pub reference_flow_cc_min:f64,pub reference_density_kg_m3:f64,pub reference_delta_pressure_pa:f64,
    pub rail_mode:InjectorRailMode,pub nominal_delta_pressure_pa:f64,pub fixed_rail_pressure_pa:f64,
    pub injector_count:usize,pub squirts_per_cycle:usize,pub max_duty_fraction:f64,
    pub actual_flow_scale:f64,pub actual_dead_time_offset_ms:f64,
    pub dead_time_map:InjectorDeadTimeMap,pub provenance:CalibrationProvenance,
}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct InjectorInput{
    pub requested_fuel_mass_flow_kgs:f64,pub rpm:f64,pub battery_voltage_v:f64,
    pub manifold_pressure_pa:f64,#[serde(default)] pub downstream_pressure_pa:Option<f64>,pub actual_rail_pressure_pa:Option<f64>,pub fuel_density_kg_m3:f64,pub injector_cut:bool,
}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct InjectorDelivery{
    pub requested_fuel_mass_flow_kgs:f64,pub injected_fuel_mass_flow_kgs:f64,
    pub pulse_width_ms:f64,pub requested_pulse_width_ms:f64,pub effective_pulse_width_ms:f64,
    pub duty_fraction:f64,pub delta_pressure_pa:f64,pub rail_pressure_pa:f64,
    pub dead_time_ms:f64,pub actual_dead_time_ms:f64,pub nominal_mass_flow_per_injector_kgs:f64,
    pub actuator_saturated:bool,pub calibration_extrapolated:bool,pub flags:Vec<String>,
}
impl InjectorConfig{
    pub fn validate(&self)->Result<(),String>{
        checked(self.reference_flow_cc_min,"Injector reference cc/min",1.0,10000.0)?;checked(self.reference_density_kg_m3,"Injector calibration-fluid density",400.0,1200.0)?;checked(self.reference_delta_pressure_pa,"Injector reference differential pressure",1000.0,300e6)?;checked(self.nominal_delta_pressure_pa,"Regulated injector differential pressure",1000.0,300e6)?;checked(self.fixed_rail_pressure_pa,"Absolute fuel rail pressure",1000.0,300e6)?;
        if self.injector_count==0||self.injector_count>48||self.squirts_per_cycle==0||self.squirts_per_cycle>8{return Err("Injector count must be 1..48 and squirts per 720 degrees 1..8.".into())}
        checked(self.max_duty_fraction,"Injector maximum duty",0.01,0.98)?;checked(self.actual_flow_scale,"Declared injector flow mismatch",0.1,2.0)?;checked(self.actual_dead_time_offset_ms,"Declared injector dead-time mismatch",-5.0,5.0)?;self.dead_time_map.validate()?;provenance(&self.provenance)
    }
}
pub fn injector_delivery(config:&InjectorConfig,input:&InjectorInput)->Result<InjectorDelivery,String>{
    config.validate()?;injector_delivery_validated(config,input)
}
fn injector_delivery_validated(config:&InjectorConfig,input:&InjectorInput)->Result<InjectorDelivery,String>{
    checked(input.requested_fuel_mass_flow_kgs,"Requested fuel flow",0.0,1e6)?;checked(input.rpm,"Injector RPM",1.0,30000.0)?;checked(input.manifold_pressure_pa,"Injector manifold pressure",1000.0,1.2e6)?;checked(input.battery_voltage_v,"Injector voltage",4.0,24.0)?;checked(input.fuel_density_kg_m3,"Actual fuel density",400.0,1200.0)?;
    let rail=if let Some(p)=input.actual_rail_pressure_pa{checked(p,"Actual absolute rail pressure",0.0,300e6)?;p}else{match config.rail_mode{InjectorRailMode::MapReferenced=>input.manifold_pressure_pa+config.nominal_delta_pressure_pa,InjectorRailMode::FixedAbsolute=>config.fixed_rail_pressure_pa}};
    let downstream=input.downstream_pressure_pa.unwrap_or(input.manifold_pressure_pa);checked(downstream,"Injector downstream absolute pressure",0.0,250e6)?;
    let delta=(rail-downstream).max(0.0);
    let(dead,extrapolated)=config.dead_time_map.sample_validated(input.battery_voltage_v,delta/1e5)?;
    let actual_dead=(dead+config.actual_dead_time_offset_ms).max(0.0);
    let q_ref=config.reference_flow_cc_min*1e-6/60.0*config.reference_density_kg_m3;
    let nominal=q_ref*((input.fuel_density_kg_m3/config.reference_density_kg_m3)*(delta/config.reference_delta_pressure_pa)).sqrt();
    let events=input.rpm/120.0*config.injector_count as f64*config.squirts_per_cycle as f64;
    let window_ms=120.0/input.rpm/config.squirts_per_cycle as f64*1000.0;
    let cut=input.injector_cut||input.requested_fuel_mass_flow_kgs==0.0;
    let requested_pw=if cut{0.0}else if nominal>0.0{input.requested_fuel_mass_flow_kgs/(nominal*events)*1000.0+dead}else{window_ms};
    let maximum=window_ms*config.max_duty_fraction;
    let pulse=if cut||delta<=0.0{0.0}else{requested_pw.min(maximum)};
    let effective=(pulse-actual_dead).max(0.0);
    let injected=nominal*config.actual_flow_scale*effective/1000.0*events;
    let mut flags=Vec::new();
    if !cut&&delta<=0.0{flags.push("no-positive-injector-differential-pressure".into())}
    if !cut&&requested_pw>maximum{flags.push("injector-duty-limited".into())}
    if !cut&&pulse<=actual_dead{flags.push("injector-pulse-below-effective-dead-time".into())}
    if extrapolated{flags.push("injector-dead-time-calibration-clamped".into())}
    let saturated=!cut&&(delta<=0.0||requested_pw>maximum||pulse<=actual_dead);
    Ok(InjectorDelivery{requested_fuel_mass_flow_kgs:input.requested_fuel_mass_flow_kgs,injected_fuel_mass_flow_kgs:injected,pulse_width_ms:pulse,requested_pulse_width_ms:requested_pw,effective_pulse_width_ms:effective,duty_fraction:pulse/window_ms,delta_pressure_pa:delta,rail_pressure_pa:rail,dead_time_ms:dead,actual_dead_time_ms:actual_dead,nominal_mass_flow_per_injector_kgs:nominal,actuator_saturated:saturated,calibration_extrapolated:extrapolated,flags})
}

#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct FilmConfig{pub deposited_fraction:f64,pub evaporation_time_seconds:f64,pub cold_deposition_gain:f64,pub cold_tau_gain:f64,pub reference_temperature_k:f64,pub initial_film_mass_kg:f64,pub provenance:CalibrationProvenance}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct LambdaSensorConfig{pub base_delay_seconds:f64,pub cycle_delay_degrees:f64,pub transport_delay_scale_kg:f64,pub maximum_delay_seconds:f64,pub time_constant_seconds:f64,pub warmup_seconds:f64,pub provenance:CalibrationProvenance}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct FeedbackConfig{pub enabled:bool,pub kp:f64,pub ki_per_second:f64,pub trim_min:f64,pub trim_max:f64,pub sample_period_seconds:f64,pub warmup_seconds:f64,pub min_coolant_temperature_k:f64,pub transient_throttle_rate_per_second:f64,pub transient_map_rate_pa_per_second:f64,pub transient_rpm_rate_per_second:f64,pub steady_hold_seconds:f64}
#[derive(Clone,Copy,Debug,Default,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub enum CombustionMode{#[default] PortInjectionSpark,DirectInjectionDiesel}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct DieselConfig{
    pub fuel:FuelComponent,pub injector:InjectorConfig,pub fuel_quantity_map:EcuMap,pub minimum_lambda_map:EcuMap,pub injection_advance_map:EcuMap,
    pub ignition_delay_deg:f64,pub burn_duration_deg:f64,pub air_throttle_fraction:f64,pub idle_fuel_mg_per_cycle:f64,pub idle_target_rpm:f64,pub max_injection_duration_deg:f64,pub provenance:CalibrationProvenance,
}
impl DieselConfig{
    fn default_for(engine:&EngineConfig)->Self{let mut injector=EcuConfig::default_si_injector(engine);injector.reference_flow_cc_min=1800.0;injector.reference_density_kg_m3=830.0;injector.reference_delta_pressure_pa=60e6;injector.nominal_delta_pressure_pa=60e6;injector.fixed_rail_pressure_pa=60e6;injector.rail_mode=InjectorRailMode::FixedAbsolute;injector.squirts_per_cycle=1;injector.dead_time_map=InjectorDeadTimeMap{voltage_v:vec![8.0,16.0],delta_pressure_bar:vec![200.0,1800.0],values_ms:vec![vec![0.4,0.5],vec![0.12,0.16]],provenance:assumed("Synthetic high-pressure single-main injector offset")};injector.provenance=assumed("Synthetic 60 MPa common-rail actuator; no hardware characterization");Self{fuel:FuelComponent{density_kg_m3:830.0,stoich_afr:14.5,lhv_jkg:42.7e6,provenance:assumed("Assumed diesel end member; no ethanol blending")},injector,fuel_quantity_map:EcuMap::constant_for(engine,EcuMapKind::DieselFuelQuantity,30.0),minimum_lambda_map:EcuMap::constant_for(engine,EcuMapKind::DieselMinimumLambda,1.3),injection_advance_map:EcuMap::constant_for(engine,EcuMapKind::DieselInjectionAdvance,12.0),ignition_delay_deg:6.0,burn_duration_deg:45.0,air_throttle_fraction:1.0,idle_fuel_mg_per_cycle:3.0,idle_target_rpm:engine.idle_rpm,max_injection_duration_deg:30.0,provenance:assumed("Prescribed direct-injection compression ignition; no spray/cetane/emissions model")}}
    fn validate(&self)->Result<(),String>{for(map,kind)in[(&self.fuel_quantity_map,EcuMapKind::DieselFuelQuantity),(&self.minimum_lambda_map,EcuMapKind::DieselMinimumLambda),(&self.injection_advance_map,EcuMapKind::DieselInjectionAdvance)]{if map.kind!=kind{return Err("Diesel map kind does not match its slot.".into())}map.validate()?}self.injector.validate()?;if self.injector.squirts_per_cycle!=1{return Err("Prescribed diesel mode supports one main injection per 720 degrees only.".into())}for(n,label,lo,hi)in[(self.fuel.density_kg_m3,"Diesel density",400.0,1200.0),(self.fuel.stoich_afr,"Diesel stoichiometric AFR",2.0,25.0),(self.fuel.lhv_jkg,"Diesel LHV",1e6,60e6),(self.ignition_delay_deg,"Prescribed diesel ignition delay",0.0,40.0),(self.burn_duration_deg,"Prescribed diesel burn duration",8.0,120.0),(self.air_throttle_fraction,"Diesel air throttle",0.05,1.0),(self.idle_fuel_mg_per_cycle,"Diesel idle fuel per cylinder cycle",0.0,100.0),(self.idle_target_rpm,"Diesel idle RPM",300.0,3000.0),(self.max_injection_duration_deg,"Diesel maximum injection window",1.0,120.0)]{checked(n,label,lo,hi)?}provenance(&self.fuel.provenance)?;provenance(&self.provenance)}
}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct EcuConfig{
    pub enabled:bool,pub combustion_mode:CombustionMode,pub diesel:DieselConfig,pub battery_voltage_v:f64,pub lambda_target_map:EcuMap,pub fuel_correction_map:EcuMap,pub spark_advance_map:EcuMap,pub ve_estimate_map:EcuMap,
    pub fuel:FuelBlendConfig,pub injector:InjectorConfig,pub film:FilmConfig,pub sensor:LambdaSensorConfig,pub feedback:FeedbackConfig,pub provenance:CalibrationProvenance,
}
fn merge(base:&mut Value,input:&Value){if let(Some(a),Some(b))=(base.as_object_mut(),input.as_object()){for(k,v)in b{if let Some(old)=a.get_mut(k){if ["lambdaTargetMap","fuelCorrectionMap","sparkAdvanceMap","veEstimateMap","deadTimeMap","fuelQuantityMap","minimumLambdaMap","injectionAdvanceMap"].contains(&k.as_str()){*old=v.clone()}else{merge(old,v)}}else{a.insert(k.clone(),v.clone());}}}else{*base=input.clone()}}
impl EcuConfig{
    fn default_si_injector(engine:&EngineConfig)->InjectorConfig{InjectorConfig{reference_flow_cc_min:300.0,reference_density_kg_m3:740.0,reference_delta_pressure_pa:300000.0,rail_mode:InjectorRailMode::MapReferenced,nominal_delta_pressure_pa:300000.0,fixed_rail_pressure_pa:400000.0,injector_count:engine.cylinders,squirts_per_cycle:1,max_duty_fraction:0.85,actual_flow_scale:1.0,actual_dead_time_offset_ms:0.0,dead_time_map:InjectorDeadTimeMap{voltage_v:vec![8.0,16.0],delta_pressure_bar:vec![1.0,6.0],values_ms:vec![vec![2.0,2.4],vec![0.7,1.1]],provenance:assumed("Synthetic voltage/pressure dead-time surface")},provenance:assumed("Assumed injector and supply")}}
    pub fn default_for(engine:&EngineConfig)->Self{
        Self{enabled:false,combustion_mode:CombustionMode::PortInjectionSpark,diesel:DieselConfig::default_for(engine),battery_voltage_v:13.8,lambda_target_map:EcuMap::constant_for(engine,EcuMapKind::LambdaTarget,1.0),fuel_correction_map:EcuMap::constant_for(engine,EcuMapKind::FuelCorrection,1.0),spark_advance_map:EcuMap::constant_for(engine,EcuMapKind::SparkAdvance,18.0),ve_estimate_map:EcuMap::constant_for(engine,EcuMapKind::VeEstimate,0.88),
            fuel:FuelBlendConfig{ethanol_volume_fraction:0.0,gasoline:FuelComponent{density_kg_m3:740.0,stoich_afr:14.7,lhv_jkg:43e6,provenance:assumed("Assumed gasoline end member")},ethanol:FuelComponent{density_kg_m3:790.0,stoich_afr:9.0,lhv_jkg:26.8e6,provenance:assumed("Assumed ethanol end member")}},
            injector:Self::default_si_injector(engine),
            film:FilmConfig{deposited_fraction:0.2,evaporation_time_seconds:0.15,cold_deposition_gain:0.15,cold_tau_gain:2.0,reference_temperature_k:353.15,initial_film_mass_kg:0.0,provenance:assumed("Original single-time-constant two-component film")},
            sensor:LambdaSensorConfig{base_delay_seconds:0.02,cycle_delay_degrees:540.0,transport_delay_scale_kg:0.001,maximum_delay_seconds:1.0,time_constant_seconds:0.08,warmup_seconds:0.3,provenance:assumed("Delayed mass-ratio proxy; not oxygen chemistry")},
            feedback:FeedbackConfig{enabled:true,kp:0.25,ki_per_second:0.4,trim_min:0.7,trim_max:1.3,sample_period_seconds:0.02,warmup_seconds:0.7,min_coolant_temperature_k:333.15,transient_throttle_rate_per_second:0.8,transient_map_rate_pa_per_second:60000.0,transient_rpm_rate_per_second:300.0,steady_hold_seconds:0.25},provenance:assumed("Original uncalibrated PFI controller")}
    }
    pub fn from_value(engine:&EngineConfig,input:&Value)->Result<Self,String>{if !input.is_object()&&!input.is_null(){return Err("ECU configuration must be an object.".into())}let mut v=serde_json::to_value(Self::default_for(engine)).map_err(|e|e.to_string())?;if input.is_object(){merge(&mut v,input)}let result:Self=serde_json::from_value(v).map_err(|e|format!("Invalid ECU configuration: {e}"))?;result.validate()?;Ok(result)}
    pub fn validate(&self)->Result<(),String>{
        for(map,kind)in [(&self.lambda_target_map,EcuMapKind::LambdaTarget),(&self.fuel_correction_map,EcuMapKind::FuelCorrection),(&self.spark_advance_map,EcuMapKind::SparkAdvance),(&self.ve_estimate_map,EcuMapKind::VeEstimate)]{if map.kind!=kind{return Err("ECU map kind does not match its slot.".into())}map.validate()?}
        self.diesel.validate()?;checked(self.battery_voltage_v,"ECU battery voltage",4.0,24.0)?;self.fuel.validate()?;self.injector.validate()?;provenance(&self.provenance)?;provenance(&self.film.provenance)?;provenance(&self.sensor.provenance)?;
        for(n,label,lo,hi)in[(self.film.deposited_fraction,"Film deposited fraction",0.0,0.95),(self.film.evaporation_time_seconds,"Film evaporation time",0.001,10.0),(self.film.cold_deposition_gain,"Cold film deposition gain",0.0,0.8),(self.film.cold_tau_gain,"Cold film time gain",0.0,10.0),(self.film.reference_temperature_k,"Film reference temperature",250.0,500.0),(self.film.initial_film_mass_kg,"Initial fuel-film mass",0.0,0.1),(self.sensor.base_delay_seconds,"Sensor base delay",0.0,2.0),(self.sensor.cycle_delay_degrees,"Sensor crank-angle delay",0.0,1440.0),(self.sensor.transport_delay_scale_kg,"Sensor flow-delay scale",0.0,0.1),(self.sensor.maximum_delay_seconds,"Sensor maximum delay",0.0,2.0),(self.sensor.time_constant_seconds,"Sensor lag",0.001,2.0),(self.sensor.warmup_seconds,"Sensor warmup",0.0,120.0),(self.feedback.kp,"Lambda proportional gain",0.0,10.0),(self.feedback.ki_per_second,"Lambda integral gain",0.0,10.0),(self.feedback.trim_min,"Minimum fuel trim",0.1,1.0),(self.feedback.trim_max,"Maximum fuel trim",1.0,4.0),(self.feedback.sample_period_seconds,"Controller sample period",0.001,1.0),(self.feedback.warmup_seconds,"Controller warmup",0.0,120.0),(self.feedback.min_coolant_temperature_k,"Feedback coolant threshold",250.0,500.0),(self.feedback.transient_throttle_rate_per_second,"Throttle transient threshold",0.01,100.0),(self.feedback.transient_map_rate_pa_per_second,"MAP transient threshold",100.0,1e8),(self.feedback.transient_rpm_rate_per_second,"RPM transient threshold",1.0,1e6),(self.feedback.steady_hold_seconds,"Transient settling hold",0.0,10.0)]{checked(n,label,lo,hi)?}
        Ok(())
    }
}
impl Default for EcuConfig{fn default()->Self{Self::default_for(&EngineConfig::default())}}

#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(default,rename_all="camelCase")]
pub struct EcuInput{
    pub rpm:f64,pub cylinders:usize,pub displacement_l:f64,pub map_pressure_pa:f64,pub intake_temperature_k:f64,pub coolant_temperature_k:f64,pub throttle:f64,pub battery_voltage_v:f64,pub actual_air_mass_flow_kgs:f64,pub injector_cut:bool,pub combustion_cut:bool,pub actual_rail_pressure_pa:Option<f64>,pub injection_downstream_pressure_pa:Option<f64>,pub requested_fuel_quantity_override_mg:Option<f64>,pub sensor_valid:bool,
}
impl Default for EcuInput{fn default()->Self{Self{rpm:3000.0,cylinders:4,displacement_l:2.0,map_pressure_pa:80000.0,intake_temperature_k:315.0,coolant_temperature_k:353.15,throttle:0.5,battery_voltage_v:13.8,actual_air_mass_flow_kgs:0.04,injector_cut:false,combustion_cut:false,actual_rail_pressure_pa:None,injection_downstream_pressure_pa:None,requested_fuel_quantity_override_mg:None,sensor_valid:true}}}
impl EcuInput{pub fn validate(&self)->Result<(),String>{for(n,label,lo,hi)in[(self.rpm,"ECU RPM",1.0,30000.0),(self.displacement_l,"ECU displacement litres",0.05,30.0),(self.map_pressure_pa,"ECU absolute MAP",1000.0,1.2e6),(self.intake_temperature_k,"ECU intake temperature",150.0,1500.0),(self.coolant_temperature_k,"ECU coolant temperature",150.0,1000.0),(self.throttle,"ECU throttle",0.0,1.0),(self.battery_voltage_v,"ECU battery voltage",4.0,24.0),(self.actual_air_mass_flow_kgs,"Actual cylinder fresh-air flow",0.0,10.0)]{checked(n,label,lo,hi)?}if self.cylinders==0||self.cylinders>24{return Err("ECU cylinder count must be 1..24.".into())}if let Some(p)=self.actual_rail_pressure_pa{checked(p,"Actual absolute rail pressure",0.0,300e6)?}if let Some(p)=self.injection_downstream_pressure_pa{checked(p,"Actual DI downstream pressure",0.0,250e6)?}if let Some(q)=self.requested_fuel_quantity_override_mg{checked(q,"Direct diesel quantity override",0.0,500.0)?}Ok(())}}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct EcuState{
    pub enabled:bool,pub combustion_mode:CombustionMode,pub minimum_lambda:Option<f64>,pub requested_fuel_mg_per_cylinder_cycle:f64,pub air_limited_fuel_mg_per_cylinder_cycle:f64,pub delivered_fuel_mg_per_cylinder_cycle:f64,pub injection_advance_deg:Option<f64>,pub injection_start_angle_deg:Option<f64>,pub start_of_combustion_deg:Option<f64>,pub prescribed_ignition_delay_deg:Option<f64>,pub prescribed_burn_duration_deg:Option<f64>,pub injection_duration_deg:Option<f64>,pub effective_injection_duration_deg:Option<f64>,pub air_throttle_fraction:f64,pub fuel_quantity_limited:bool,pub elapsed_seconds:f64,pub estimated_air_mass_flow_kgs:f64,pub actual_air_mass_flow_kgs:f64,
    pub target_lambda:f64,pub spark_advance_deg:f64,pub fuel_correction:f64,pub feedback_trim:f64,
    pub requested_fuel_mass_flow_kgs:f64,pub injected_fuel_mass_flow_kgs:f64,pub delivered_fuel_mass_flow_kgs:f64,
    pub burnable_fuel_mass_flow_kgs:f64,pub unburned_fuel_mass_flow_kgs:f64,pub fuel_energy_w:f64,pub burnable_fuel_energy_w:f64,
    pub stoich_afr:f64,pub fuel_lhv_jkg:f64,pub fuel_density_kg_m3:f64,pub ethanol_mass_fraction:f64,
    pub feed_fuel_properties:FuelBlendProperties,pub delivered_fuel_properties:FuelBlendProperties,
    pub fuel_mass_per_cylinder_cycle_kg:f64,pub burnable_fuel_mass_per_cylinder_cycle_kg:f64,
    pub wall_film_mass_kg:f64,pub film_gasoline_mass_kg:f64,pub film_ethanol_mass_kg:f64,
    pub true_lambda:Option<f64>,pub observed_lambda:Option<f64>,pub sensor_ready:bool,
    pub injector_cut:bool,pub combustion_cut:bool,pub pulse_width_ms:f64,pub effective_pulse_width_ms:f64,
    pub duty_fraction:f64,pub delta_pressure_pa:f64,pub rail_pressure_pa:f64,pub dead_time_ms:f64,
    pub injected_mass_kg:f64,pub delivered_mass_kg:f64,pub cumulative_injected_mass_kg:f64,pub cumulative_delivered_mass_kg:f64,pub cumulative_unburned_mass_kg:f64,pub fuel_mass_residual_kg:f64,
    pub mode:String,pub feedback_active:bool,pub can_learn:bool,pub applied_fuel_multiplier:f64,pub sensor_delay_seconds:f64,pub gates:Vec<String>,pub learning_gates:Vec<String>,pub flags:Vec<String>,pub maps_extrapolated:bool,pub actuator_saturated:bool,pub quantitatively_valid:bool,
}

fn empty_state(config:&EcuConfig)->EcuState{
    let is_diesel=config.combustion_mode==CombustionMode::DirectInjectionDiesel;
    let properties=if is_diesel{let f=&config.diesel.fuel;if [f.density_kg_m3,f.stoich_afr,f.lhv_jkg].iter().all(|v|v.is_finite())&&f.density_kg_m3>0.0{diesel_properties(f)}else{diesel_properties(&EcuConfig::default().diesel.fuel)}}else{let f=&config.fuel;let finite=[f.ethanol_volume_fraction,f.gasoline.density_kg_m3,f.ethanol.density_kg_m3,f.gasoline.stoich_afr,f.ethanol.stoich_afr,f.gasoline.lhv_jkg,f.ethanol.lhv_jkg].iter().all(|v|v.is_finite())&&f.gasoline.density_kg_m3>0.0&&f.ethanol.density_kg_m3>0.0;if finite{feed_properties(f)}else{feed_properties(&EcuConfig::default().fuel)}};
    EcuState{enabled:config.enabled,combustion_mode:config.combustion_mode,minimum_lambda:None,requested_fuel_mg_per_cylinder_cycle:0.0,air_limited_fuel_mg_per_cylinder_cycle:0.0,delivered_fuel_mg_per_cylinder_cycle:0.0,injection_advance_deg:None,injection_start_angle_deg:None,start_of_combustion_deg:None,prescribed_ignition_delay_deg:None,prescribed_burn_duration_deg:None,injection_duration_deg:None,effective_injection_duration_deg:None,air_throttle_fraction:if is_diesel{config.diesel.air_throttle_fraction}else{1.0},fuel_quantity_limited:false,elapsed_seconds:0.0,estimated_air_mass_flow_kgs:0.0,actual_air_mass_flow_kgs:0.0,target_lambda:if is_diesel{0.0}else{1.0},spark_advance_deg:if is_diesel{0.0}else{18.0},fuel_correction:1.0,feedback_trim:1.0,requested_fuel_mass_flow_kgs:0.0,injected_fuel_mass_flow_kgs:0.0,delivered_fuel_mass_flow_kgs:0.0,burnable_fuel_mass_flow_kgs:0.0,unburned_fuel_mass_flow_kgs:0.0,fuel_energy_w:0.0,burnable_fuel_energy_w:0.0,stoich_afr:properties.stoich_afr,fuel_lhv_jkg:properties.lhv_jkg,fuel_density_kg_m3:properties.density_kg_m3,ethanol_mass_fraction:properties.ethanol_mass_fraction,feed_fuel_properties:properties.clone(),delivered_fuel_properties:properties,fuel_mass_per_cylinder_cycle_kg:0.0,burnable_fuel_mass_per_cylinder_cycle_kg:0.0,wall_film_mass_kg:0.0,film_gasoline_mass_kg:0.0,film_ethanol_mass_kg:0.0,true_lambda:None,observed_lambda:None,sensor_ready:false,injector_cut:false,combustion_cut:false,pulse_width_ms:0.0,effective_pulse_width_ms:0.0,duty_fraction:0.0,delta_pressure_pa:0.0,rail_pressure_pa:0.0,dead_time_ms:0.0,injected_mass_kg:0.0,delivered_mass_kg:0.0,cumulative_injected_mass_kg:0.0,cumulative_delivered_mass_kg:0.0,cumulative_unburned_mass_kg:0.0,fuel_mass_residual_kg:0.0,mode:if config.enabled{"initializing".into()}else{"disabled".into()},feedback_active:false,can_learn:false,applied_fuel_multiplier:1.0,sensor_delay_seconds:0.0,gates:vec!["uninitialized".into()],learning_gates:vec!["uninitialized".into()],flags:vec!["mass-ratio-lambda-proxy-not-oxygen-chemistry".into()],maps_extrapolated:false,actuator_saturated:false,quantitatively_valid:false}
}
impl Default for EcuState{fn default()->Self{empty_state(&EcuConfig::default())}}
struct DieselPrepared{requested_mg:f64,limited_mg:f64,minimum_lambda:f64,soi:f64,quantity_limited:bool}
struct Prepared{diesel:Option<DieselPrepared>,target:f64,spark:f64,correction:f64,estimated_air:f64,feed:FuelBlendProperties,actuator:InjectorDelivery,extrapolated:bool,trim:f64}
fn diesel_properties(fuel:&FuelComponent)->FuelBlendProperties{FuelBlendProperties{ethanol_volume_fraction:0.0,ethanol_mass_fraction:0.0,density_kg_m3:fuel.density_kg_m3,stoich_afr:fuel.stoich_afr,lhv_jkg:fuel.lhv_jkg,status:"assumed-single-diesel-fuel".into()}}
fn prepare_diesel(config:&EcuConfig,input:&EcuInput)->Result<Prepared,String>{
    let diesel=&config.diesel;
    let downstream=input.injection_downstream_pressure_pa.ok_or("Direct-injection diesel requires explicit cylinder pressure at the prescribed hydraulic SOI; MAP is not a substitute.")?;
    let pressure=input.map_pressure_pa/1e5;
    let quantity=diesel.fuel_quantity_map.sample_validated(input.rpm,pressure)?;
    let minimum=diesel.minimum_lambda_map.sample_validated(input.rpm,pressure)?;
    let advance=diesel.injection_advance_map.sample_validated(input.rpm,pressure)?;
    let ve=config.ve_estimate_map.sample_validated(input.rpm,pressure)?;
    let feed=diesel_properties(&diesel.fuel);
    let estimated_air=ve.value*input.map_pressure_pa/(AIR_R*input.intake_temperature_k)*input.displacement_l*1e-3*input.rpm/120.0;
    let idle=diesel.idle_fuel_mg_per_cycle*((diesel.idle_target_rpm*1.05-input.rpm)/(diesel.idle_target_rpm*0.1)).clamp(0.0,1.0);
    let requested=if input.injector_cut{0.0}else{input.requested_fuel_quantity_override_mg.unwrap_or((input.throttle*quantity.value).max(idle))};
    let cycles=input.rpm/120.0*input.cylinders as f64;
    let desired_flow=requested*1e-6*cycles;
    let limited_flow=desired_flow.min(estimated_air/(feed.stoich_afr*minimum.value));
    let limited_mg=limited_flow/cycles*1e6;
    let mut injector=diesel.injector.clone();injector.max_duty_fraction=injector.max_duty_fraction.min(diesel.max_injection_duration_deg/720.0);
    let actuator=injector_delivery_validated(&injector,&InjectorInput{requested_fuel_mass_flow_kgs:limited_flow,rpm:input.rpm,battery_voltage_v:input.battery_voltage_v,manifold_pressure_pa:input.map_pressure_pa,downstream_pressure_pa:Some(downstream),actual_rail_pressure_pa:input.actual_rail_pressure_pa,fuel_density_kg_m3:feed.density_kg_m3,injector_cut:input.injector_cut})?;
    let extrapolated=quantity.extrapolated||minimum.extrapolated||advance.extrapolated||ve.extrapolated||actuator.calibration_extrapolated;
    Ok(Prepared{diesel:Some(DieselPrepared{requested_mg:requested,limited_mg,minimum_lambda:minimum.value,soi:advance.value,quantity_limited:limited_flow+1e-15<desired_flow}),target:0.0,spark:0.0,correction:1.0,estimated_air,feed,actuator,extrapolated,trim:1.0})
}
fn prepare(config:&EcuConfig,input:&EcuInput,trim:f64)->Result<Prepared,String>{
    if config.combustion_mode==CombustionMode::DirectInjectionDiesel{return prepare_diesel(config,input)}
    if input.requested_fuel_quantity_override_mg.is_some(){return Err("Diesel quantity override is not valid for port-injection spark mode.".into())}
    let pressure=input.map_pressure_pa/1e5;
    let target=config.lambda_target_map.sample_validated(input.rpm,pressure)?;
    let correction=config.fuel_correction_map.sample_validated(input.rpm,pressure)?;
    let spark=config.spark_advance_map.sample_validated(input.rpm,pressure)?;
    let ve=config.ve_estimate_map.sample_validated(input.rpm,pressure)?;
    let feed=feed_properties(&config.fuel);
    // Only sensor/VE-model variables enter feedforward; actual_air_mass_flow_kgs
    // must not appear in this estimate or desired fuel calculation.
    let estimated_air=ve.value*input.map_pressure_pa/(AIR_R*input.intake_temperature_k)*input.displacement_l*1e-3*input.rpm/120.0;
    let desired=if input.injector_cut{0.0}else{estimated_air/(target.value*feed.stoich_afr)*correction.value*trim};
    let actuator=injector_delivery_validated(&config.injector,&InjectorInput{requested_fuel_mass_flow_kgs:desired,rpm:input.rpm,battery_voltage_v:input.battery_voltage_v,manifold_pressure_pa:input.map_pressure_pa,downstream_pressure_pa:None,actual_rail_pressure_pa:input.actual_rail_pressure_pa,fuel_density_kg_m3:feed.density_kg_m3,injector_cut:input.injector_cut})?;
    let extrapolated=target.extrapolated||correction.extrapolated||spark.extrapolated||ve.extrapolated||actuator.calibration_extrapolated;
    Ok(Prepared{diesel:None,target:target.value,spark:spark.value,correction:correction.value,estimated_air,feed,actuator,extrapolated,trim})
}
fn film_parameters(config:&FilmConfig,temperature:f64)->(f64,f64){
    let cold=((config.reference_temperature_k-temperature)/100.0).clamp(0.0,1.5);
    ((config.deposited_fraction+config.cold_deposition_gain*cold).clamp(0.0,0.95),config.evaporation_time_seconds*(1.0+config.cold_tau_gain*cold))
}
/// Exact constant-input film inventory step. The returned delivered mass is the
/// injector input mass minus inventory change, so the ledger stays explicit.
pub fn advance_fuel_film(mass:f64,input_flow:f64,x:f64,tau:f64,dt:f64)->Result<(f64,f64),String>{
    checked(mass,"Fuel-film mass",0.0,1e6)?;checked(input_flow,"Fuel-film input flow",0.0,1e6)?;checked(x,"Fuel-film deposited fraction",0.0,1.0)?;checked(tau,"Fuel-film evaporation time",1e-6,1e6)?;checked(dt,"Fuel-film step",0.0,10.0)?;
    let alpha=-(-dt/tau).exp_m1();let next=mass*(-dt/tau).exp()+x*input_flow*tau*alpha;
    let delivered=input_flow*dt-(next-mass);
    if delivered < -1e-12||!next.is_finite(){return Err("Fuel-film integration left its mass domain.".into())}Ok((next,delivered.max(0.0)))
}
fn fill_state(config:&EcuConfig,input:&EcuInput,p:&Prepared,delivered:f64,delivered_properties:FuelBlendProperties)->EcuState{
    let mut s=empty_state(config);
    let burnable=if input.combustion_cut{0.0}else{delivered.min(input.actual_air_mass_flow_kgs/delivered_properties.stoich_afr)};
    let events=input.rpm/120.0*input.cylinders as f64;
    s.estimated_air_mass_flow_kgs=p.estimated_air;s.actual_air_mass_flow_kgs=input.actual_air_mass_flow_kgs;s.target_lambda=p.target;s.spark_advance_deg=p.spark;s.fuel_correction=p.correction;s.feedback_trim=p.trim;s.applied_fuel_multiplier=p.correction*p.trim;
    s.requested_fuel_mass_flow_kgs=p.actuator.requested_fuel_mass_flow_kgs;s.injected_fuel_mass_flow_kgs=p.actuator.injected_fuel_mass_flow_kgs;s.delivered_fuel_mass_flow_kgs=delivered;s.burnable_fuel_mass_flow_kgs=burnable;s.unburned_fuel_mass_flow_kgs=(delivered-burnable).max(0.0);
    s.fuel_energy_w=delivered*delivered_properties.lhv_jkg;s.burnable_fuel_energy_w=burnable*delivered_properties.lhv_jkg;
    s.stoich_afr=delivered_properties.stoich_afr;s.fuel_lhv_jkg=delivered_properties.lhv_jkg;s.fuel_density_kg_m3=delivered_properties.density_kg_m3;s.ethanol_mass_fraction=delivered_properties.ethanol_mass_fraction;
    s.feed_fuel_properties=p.feed.clone();s.delivered_fuel_properties=delivered_properties;
    s.fuel_mass_per_cylinder_cycle_kg=delivered/events;s.burnable_fuel_mass_per_cylinder_cycle_kg=burnable/events;
    s.true_lambda=if delivered>1e-15{Some(input.actual_air_mass_flow_kgs/(s.stoich_afr*delivered))}else{None};
    s.injector_cut=input.injector_cut;s.combustion_cut=input.combustion_cut;s.pulse_width_ms=p.actuator.pulse_width_ms;s.effective_pulse_width_ms=p.actuator.effective_pulse_width_ms;s.duty_fraction=p.actuator.duty_fraction;s.delta_pressure_pa=p.actuator.delta_pressure_pa;s.rail_pressure_pa=p.actuator.rail_pressure_pa;s.dead_time_ms=p.actuator.dead_time_ms;
    s.flags.extend(p.actuator.flags.clone());if p.extrapolated{s.flags.push("ecu-map-or-injector-calibration-clamped".into())}if input.combustion_cut{s.flags.push("combustion-disabled-delivered-fuel-is-unburned".into())}else if burnable+1e-15<delivered{s.flags.push("rich-mixture-oxygen-availability-limited".into())}
    s.maps_extrapolated=p.extrapolated;s.actuator_saturated=p.actuator.actuator_saturated;s.quantitatively_valid=!s.maps_extrapolated&&!s.actuator_saturated;
    s.requested_fuel_mg_per_cylinder_cycle=s.requested_fuel_mass_flow_kgs/events*1e6;s.air_limited_fuel_mg_per_cylinder_cycle=s.requested_fuel_mg_per_cylinder_cycle;s.delivered_fuel_mg_per_cylinder_cycle=s.fuel_mass_per_cylinder_cycle_kg*1e6;s.air_throttle_fraction=input.throttle;
    if let Some(di)=&p.diesel{s.minimum_lambda=Some(di.minimum_lambda);s.requested_fuel_mg_per_cylinder_cycle=di.requested_mg;s.air_limited_fuel_mg_per_cylinder_cycle=di.limited_mg;s.fuel_quantity_limited=di.quantity_limited;s.injection_advance_deg=Some(di.soi);s.injection_start_angle_deg=Some(360.0-di.soi);s.start_of_combustion_deg=Some(360.0-di.soi+config.diesel.ignition_delay_deg);s.prescribed_ignition_delay_deg=Some(config.diesel.ignition_delay_deg);s.prescribed_burn_duration_deg=Some(config.diesel.burn_duration_deg);s.injection_duration_deg=Some(6.0*input.rpm*s.pulse_width_ms/1000.0);s.effective_injection_duration_deg=Some(6.0*input.rpm*s.effective_pulse_width_ms/1000.0);s.air_throttle_fraction=config.diesel.air_throttle_fraction;s.flags.push("diesel-single-main-prescribed-hydraulic-soi-ignition-delay-and-burn-not-spray-cetane-or-emissions".into());if di.quantity_limited{s.flags.push("diesel-estimated-air-minimum-lambda-quantity-limit".into())}if s.true_lambda.is_some_and(|value|value+1e-9<di.minimum_lambda){s.flags.push("diesel-actual-lambda-proxy-below-configured-minimum".into())}}
    s
}
/// Warm film equilibrium and open-loop trim=1 only. This function does not run
/// a feedback controller or claim a converged/valid simulated sensor reading.
pub fn evaluate_ecu_steady(_engine:&EngineConfig,config:&EcuConfig,input:&EcuInput)->Result<EcuState,String>{
    config.validate()?;input.validate()?;let p=prepare(config,input,1.0)?;
    let mut s=fill_state(config,input,&p,p.actuator.injected_fuel_mass_flow_kgs,p.feed.clone());
    let(x,tau)=if config.combustion_mode==CombustionMode::DirectInjectionDiesel{(0.0,0.0)}else{film_parameters(&config.film,input.coolant_temperature_k)};
    s.wall_film_mass_kg=x*p.actuator.injected_fuel_mass_flow_kgs*tau;s.film_ethanol_mass_kg=s.wall_film_mass_kg*p.feed.ethanol_mass_fraction;s.film_gasoline_mass_kg=s.wall_film_mass_kg-s.film_ethanol_mass_kg;
    s.mode=if config.combustion_mode==CombustionMode::DirectInjectionDiesel{"steady-diesel-prescribed-single-main".into()}else{"steady-open-loop-actuator-film-equilibrium".into()};s.gates=vec!["steady-evaluation-has-no-feedback-or-observation-history".into()];s.flags.push("steady-open-loop-not-feedback-convergence".into());Ok(s)
}

#[derive(Clone,Copy)]
struct ProxySample{time:f64,lambda:Option<f64>}
#[derive(Clone)]
struct LearningBlock{start:f64,end:f64,min:[f64;5],max:[f64;5]}
#[derive(Clone)]
pub struct Ecu{
    config:EcuConfig,config_error:Option<String>,state:EcuState,
    film_gasoline:f64,film_ethanol:f64,initial_film:f64,
    elapsed:f64,injected:f64,delivered:f64,unburned:f64,
    integral:f64,trim:f64,sample_elapsed:f64,steady_elapsed:f64,
    previous:Option<(f64,f64,f64)>,observed:Option<f64>,history:VecDeque<ProxySample>,learning_history:VecDeque<LearningBlock>,
}
impl Ecu{
    pub fn new(config:EcuConfig)->Self{
        let config_error=config.validate().err();let state=empty_state(&config);
        let mut ecu=Self{config,config_error,state,film_gasoline:0.0,film_ethanol:0.0,initial_film:0.0,elapsed:0.0,injected:0.0,delivered:0.0,unburned:0.0,integral:0.0,trim:1.0,sample_elapsed:0.0,steady_elapsed:0.0,previous:None,observed:None,history:VecDeque::with_capacity(512),learning_history:VecDeque::with_capacity(256)};
        ecu.reset();ecu
    }
    /// Same-mode parameter changes preserve component film inventories and labels.
    /// Every mode change requires set_config_and_reset, including zero-film and
    /// CI-to-SI changes, so observer/controller histories cannot cross modes.
    /// Explicit reset is the only operation that applies initial-film settings.
    pub fn set_config(&mut self,config:EcuConfig)->Result<(),String>{
        config.validate()?;if config.combustion_mode!=self.config.combustion_mode{return Err("Changing combustion mode requires an explicit controller reset; use set_config_and_reset.".into())}self.trim=self.trim.clamp(config.feedback.trim_min,config.feedback.trim_max);self.integral=self.integral.clamp(config.feedback.trim_min-1.0,config.feedback.trim_max-1.0);
        self.config=config;self.config_error=None;self.steady_elapsed=0.0;self.learning_history.clear();self.state.can_learn=false;self.state.learning_gates=vec!["configuration-changed-waiting-for-delayed-observation".into()];self.state.enabled=self.config.enabled;Ok(())
    }
    pub fn set_config_and_reset(&mut self,config:EcuConfig)->Result<(),String>{config.validate()?;self.config=config;self.config_error=None;self.reset();Ok(())}
    pub fn reset(&mut self){
        self.state=empty_state(&self.config);let feed=self.state.feed_fuel_properties.clone();
        self.initial_film=if self.config.combustion_mode==CombustionMode::DirectInjectionDiesel{0.0}else{self.config.film.initial_film_mass_kg};
        self.film_ethanol=self.initial_film*feed.ethanol_mass_fraction;self.film_gasoline=self.initial_film-self.film_ethanol;
        self.elapsed=0.0;self.injected=0.0;self.delivered=0.0;self.unburned=0.0;self.integral=0.0;self.trim=1.0;self.sample_elapsed=0.0;self.steady_elapsed=0.0;self.previous=None;self.observed=None;self.history.clear();self.learning_history.clear();
        self.state.wall_film_mass_kg=self.initial_film;self.state.film_gasoline_mass_kg=self.film_gasoline;self.state.film_ethanol_mass_kg=self.film_ethanol;
    }
    pub fn get_state(&self)->EcuState{self.state.clone()}
    fn push_proxy(&mut self,lambda:Option<f64>){
        if self.history.back().map(|p|self.elapsed-p.time>=0.001-1e-12).unwrap_or(true){self.history.push_back(ProxySample{time:self.elapsed,lambda});}
        let earliest=self.elapsed-self.config.sensor.maximum_delay_seconds-0.02;
        while self.history.len()>2&&self.history[1].time<earliest{self.history.pop_front();}
        while self.history.len()>4096{self.history.pop_front();}
    }
    fn delayed_proxy(&self,time:f64)->Option<f64>{
        let first=self.history.front()?;let last=self.history.back()?;
        if time<first.time||time>last.time+0.0011{return None}
        if time>=last.time{return last.lambda}
        let(mut lo,mut hi)=(0,self.history.len()-1);
        while hi-lo>1{let mid=(lo+hi)/2;if self.history[mid].time<=time{lo=mid}else{hi=mid}}
        let a=self.history[lo];let b=self.history[hi];let va=a.lambda?;let vb=b.lambda?;
        Some(va+(vb-va)*(time-a.time)/(b.time-a.time))
    }
    fn learning_stable(&mut self,p:&Prepared,input:&EcuInput,window:f64)->bool{
        let values=[p.correction*p.trim,p.actuator.requested_fuel_mass_flow_kgs,p.target,input.rpm,input.map_pressure_pa];
        if let Some(last)=self.learning_history.back_mut().filter(|b|self.elapsed-b.start<0.01){last.end=self.elapsed;for(i,v)in values.iter().enumerate(){last.min[i]=last.min[i].min(*v);last.max[i]=last.max[i].max(*v)}}else{self.learning_history.push_back(LearningBlock{start:self.elapsed,end:self.elapsed,min:values,max:values});}
        let earliest=self.elapsed-window;while self.learning_history.len()>1&&self.learning_history[1].start<earliest{self.learning_history.pop_front();}while self.learning_history.len()>4096{self.learning_history.pop_front();}
        if self.learning_history.front().map(|b|self.elapsed-b.start+1e-12<window).unwrap_or(true){return false}
        let(mut low,mut high)=(values,values);for block in &self.learning_history{for i in 0..5{low[i]=low[i].min(block.min[i]);high[i]=high[i].max(block.max[i]);}}
        let limits=[0.002,values[1].abs().max(1e-9)*0.005,0.001,input.rpm.abs().max(100.0)*0.002,input.map_pressure_pa.abs().max(1000.0)*0.002];
        (0..5).all(|i|high[i]-low[i]<=limits[i])
    }
    pub fn step(&mut self,dt:f64,input:&EcuInput)->Result<EcuState,String>{
        if let Some(error)=&self.config_error{return Err(error.clone())}checked(dt,"ECU integration step",0.0,1.0)?;input.validate()?;
        if dt==0.0{return Ok(self.get_state())}
        if !self.config.enabled{let mut disabled=empty_state(&self.config);disabled.elapsed_seconds=self.elapsed;disabled.wall_film_mass_kg=self.film_gasoline+self.film_ethanol;disabled.film_gasoline_mass_kg=self.film_gasoline;disabled.film_ethanol_mass_kg=self.film_ethanol;disabled.cumulative_injected_mass_kg=self.injected;disabled.cumulative_delivered_mass_kg=self.delivered;disabled.cumulative_unburned_mass_kg=self.unburned;disabled.fuel_mass_residual_kg=self.initial_film+self.injected-self.delivered-disabled.wall_film_mass_kg;self.state=disabled;return Ok(self.get_state())}
        // Validate all step-dependent preparation before mutating state. Config is
        // immutable after validation except through set_config's checked swap.
        prepare(&self.config,input,self.trim)?;
        let is_diesel=self.config.combustion_mode==CombustionMode::DirectInjectionDiesel;if is_diesel{self.trim=1.0;self.integral=0.0}
        let transient=if let Some((throttle,map,rpm))=self.previous{(input.throttle-throttle).abs()/dt>self.config.feedback.transient_throttle_rate_per_second||(input.map_pressure_pa-map).abs()/dt>self.config.feedback.transient_map_rate_pa_per_second||(input.rpm-rpm).abs()/dt>self.config.feedback.transient_rpm_rate_per_second}else{false};
        self.previous=Some((input.throttle,input.map_pressure_pa,input.rpm));if transient{self.steady_elapsed=0.0}
        let count=(dt/self.config.feedback.sample_period_seconds.min(0.005)).ceil().max(1.0) as usize;let h=dt/count as f64;
        let(mut step_injected,mut step_delivered,mut step_unburned,mut step_ethanol_delivered,mut step_burnable_energy)=(0.0,0.0,0.0,0.0,0.0);
        let mut p_last=prepare(&self.config,input,self.trim)?;
        for _ in 0..count{
            let p=prepare(&self.config,input,self.trim)?;let u=p.actuator.injected_fuel_mass_flow_kgs;
            let(x,tau)=film_parameters(&self.config.film,input.coolant_temperature_k);
            let(next_g,delivered_g)=if is_diesel{(0.0,u*h)}else{advance_fuel_film(self.film_gasoline,u*(1.0-p.feed.ethanol_mass_fraction),x,tau,h)?};
            let(next_e,delivered_e)=if is_diesel{(0.0,0.0)}else{advance_fuel_film(self.film_ethanol,u*p.feed.ethanol_mass_fraction,x,tau,h)?};
            self.film_gasoline=next_g;self.film_ethanol=next_e;
            let delivered_mass=delivered_g+delivered_e;
            let props=if is_diesel{p.feed.clone()}else if delivered_mass>1e-18{properties_from_mass_fraction(&self.config.fuel,delivered_e/delivered_mass)}else{p.feed.clone()};
            let flow=delivered_mass/h;
            let mut s=fill_state(&self.config,input,&p,flow,props);
            let unburned=s.unburned_fuel_mass_flow_kgs*h;
            self.elapsed+=h;self.steady_elapsed+=h;self.injected+=u*h;self.delivered+=delivered_mass;self.unburned+=unburned;
            step_injected+=u*h;step_delivered+=delivered_mass;step_unburned+=unburned;step_ethanol_delivered+=delivered_e;step_burnable_energy+=s.burnable_fuel_energy_w*h;
            self.push_proxy(s.true_lambda);
            let raw_delay=self.config.sensor.base_delay_seconds+self.config.sensor.cycle_delay_degrees/(6.0*input.rpm)+self.config.sensor.transport_delay_scale_kg/input.actual_air_mass_flow_kgs.max(0.001);
            let delay=raw_delay.min(self.config.sensor.maximum_delay_seconds);
            let proxy=self.delayed_proxy(self.elapsed-delay);
            let sensor_ready=input.sensor_valid&&self.elapsed>=self.config.sensor.warmup_seconds&&proxy.is_some();
            if sensor_ready{let value=proxy.unwrap();self.observed=Some(if let Some(old)=self.observed{value+(old-value)*(-h/self.config.sensor.time_constant_seconds).exp()}else{value});}
            let mut gates=Vec::new();
            if self.elapsed<self.config.feedback.warmup_seconds||input.coolant_temperature_k<self.config.feedback.min_coolant_temperature_k{gates.push("warmup".to_owned())}
            if input.injector_cut{gates.push("injector-cut".into())}if input.combustion_cut{gates.push("combustion-cut".into())}
            if !sensor_ready{gates.push("sensor-invalid-or-not-ready".into())}
            if s.actuator_saturated{gates.push("actuator-saturated".into())}if s.maps_extrapolated{gates.push("map-out-of-domain".into())}
            if self.steady_elapsed<self.config.feedback.steady_hold_seconds{gates.push("transient".into())}
            if raw_delay>self.config.sensor.maximum_delay_seconds{s.flags.push("sensor-delay-capped".into());gates.push("sensor-delay-out-of-domain".into());}
            let physical_gates_clear=gates.is_empty();
            let component_e_input=u*p.feed.ethanol_mass_fraction;let component_g_input=u*(1.0-p.feed.ethanol_mass_fraction);
            let film_near_steady=(u-flow).abs()/u.max(1e-9)<0.02&&(component_e_input-delivered_e/h).abs()/component_e_input.max(u*0.01).max(1e-9)<0.02&&(component_g_input-delivered_g/h).abs()/component_g_input.max(u*0.01).max(1e-9)<0.02;
            let learning_window=delay+5.0*self.config.sensor.time_constant_seconds+self.config.feedback.steady_hold_seconds;
            let learning_stable=if is_diesel{false}else{self.learning_stable(&p,input,learning_window)};
            s.learning_gates=gates.clone();if !film_near_steady{s.learning_gates.push("fuel-film-not-settled".into())}if !learning_stable{s.learning_gates.push("requested-fuel-trim-target-not-settled-for-delayed-observation".into())}if is_diesel{s.learning_gates.push("diesel-learning-not-supported".into())}
            s.can_learn=!is_diesel&&physical_gates_clear&&film_near_steady&&learning_stable;
            if is_diesel{gates.push("diesel-quantity-control-no-si-lambda-feedback".into())}
            if !self.config.feedback.enabled{gates.push("feedback-disabled".into())}
            let feedback_active=gates.is_empty();
            self.sample_elapsed+=h;
            if self.sample_elapsed+1e-12>=self.config.feedback.sample_period_seconds{
                self.sample_elapsed=(self.sample_elapsed-self.config.feedback.sample_period_seconds).max(0.0);
                if feedback_active{
                    let error=self.observed.unwrap()-p.target;
                    let candidate=self.integral+self.config.feedback.ki_per_second*error*self.config.feedback.sample_period_seconds;
                    let trial=1.0+self.config.feedback.kp*error+candidate;
                    if !(trial>self.config.feedback.trim_max&&error>0.0||trial<self.config.feedback.trim_min&&error<0.0){self.integral=candidate;}
                    self.trim=(1.0+self.config.feedback.kp*error+self.integral).clamp(self.config.feedback.trim_min,self.config.feedback.trim_max);
                }
            }
            s.elapsed_seconds=self.elapsed;s.observed_lambda=self.observed;s.sensor_ready=sensor_ready;s.sensor_delay_seconds=delay;s.feedback_active=feedback_active;
            s.mode=if is_diesel{"diesel-prescribed-single-main".into()}else if feedback_active{"closed-loop".into()}else if !self.config.feedback.enabled&&physical_gates_clear{"open-loop".into()}else{gates.first().cloned().unwrap_or_else(||"open-loop".into())};
            s.gates=gates;s.wall_film_mass_kg=self.film_gasoline+self.film_ethanol;s.film_gasoline_mass_kg=self.film_gasoline;s.film_ethanol_mass_kg=self.film_ethanol;
            s.cumulative_injected_mass_kg=self.injected;s.cumulative_delivered_mass_kg=self.delivered;s.cumulative_unburned_mass_kg=self.unburned;
            s.fuel_mass_residual_kg=self.initial_film+self.injected-self.delivered-s.wall_film_mass_kg;
            p_last=p;self.state=s;
        }
        // Returned flow and energy summarize the whole requested step, rather
        // than reporting only its final substep. Pulse/trim are the final held
        // actuator point; their provenance is explicit through appliedMultiplier.
        let delivered_props=if is_diesel{p_last.feed.clone()}else if step_delivered>1e-18{properties_from_mass_fraction(&self.config.fuel,step_ethanol_delivered/step_delivered)}else{p_last.feed.clone()};
        self.state.injected_mass_kg=step_injected;self.state.delivered_mass_kg=step_delivered;
        self.state.injected_fuel_mass_flow_kgs=step_injected/dt;self.state.delivered_fuel_mass_flow_kgs=step_delivered/dt;self.state.unburned_fuel_mass_flow_kgs=step_unburned/dt;self.state.burnable_fuel_mass_flow_kgs=(step_delivered-step_unburned).max(0.0)/dt;
        self.state.stoich_afr=delivered_props.stoich_afr;self.state.fuel_lhv_jkg=delivered_props.lhv_jkg;self.state.fuel_density_kg_m3=delivered_props.density_kg_m3;self.state.ethanol_mass_fraction=delivered_props.ethanol_mass_fraction;self.state.delivered_fuel_properties=delivered_props;
        self.state.fuel_energy_w=self.state.delivered_fuel_mass_flow_kgs*self.state.fuel_lhv_jkg;self.state.burnable_fuel_energy_w=step_burnable_energy/dt;
        let events=input.rpm/120.0*input.cylinders as f64;self.state.fuel_mass_per_cylinder_cycle_kg=self.state.delivered_fuel_mass_flow_kgs/events;self.state.burnable_fuel_mass_per_cylinder_cycle_kg=self.state.burnable_fuel_mass_flow_kgs/events;self.state.delivered_fuel_mg_per_cylinder_cycle=self.state.fuel_mass_per_cylinder_cycle_kg*1e6;
        self.state.true_lambda=if self.state.delivered_fuel_mass_flow_kgs>1e-15{Some(input.actual_air_mass_flow_kgs/(self.state.stoich_afr*self.state.delivered_fuel_mass_flow_kgs))}else{None};
        Ok(self.get_state())
    }
}
