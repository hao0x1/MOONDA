"""Validate delivered MOONDA features against source data and true coordinates.

Run: /Volumes/CodexWork/Projects/MOONDA/.venv-data/bin/python -I features/scripts/check.py
Writes only features/out/check-report.json. Previews: features/scripts/previews.py.
"""
from __future__ import annotations
import csv
import json
from pathlib import Path
import sys
sys.dont_write_bytecode = True
import numpy as np
import rasterio
from PIL import Image
from scipy.ndimage import maximum_filter, minimum_filter

ROOT = Path(__file__).resolve().parents[2]
PROJECT = ROOT.parent
OUT = ROOT / 'features/out'
R = 1737400.
HALF = 304000.
N = 2048
RES = 296.875
FIELDS = {'id','title','shortHelp','units','scale','offset','valueMin','valueMax','legend','source','notes'}
SOURCE_FIELDS = {'name','url','citation','version'}
PROBLEMS = []


def test(condition, text):
    if not condition:
        PROBLEMS.append(text)
    return bool(condition)


def xy(lat, lon):
    rho = 2*R*np.tan(np.pi/4+np.radians(lat)/2)
    return rho*np.sin(np.radians(lon)), rho*np.cos(np.radians(lon))


def latlon(x, y):
    return -90+np.degrees(2*np.arctan(np.hypot(x,y)/(2*R))), np.degrees(np.arctan2(x,y))


def pixel(lat, lon, n=N):
    x, y = xy(lat,lon)
    return int(np.floor((HALF-y)/(2*HALF/n))), int(np.floor((x+HALF)/(2*HALF/n)))


def mask(n):
    axis = -HALF+(np.arange(n)+.5)*2*HALF/n
    rho = 2*R*np.tan(np.radians(5))
    return axis[None,:]**2+axis[:,None]**2 <= rho**2


def read(lid):
    p = OUT / f'{lid}.bin'
    test(p.stat().st_size == N*N*2, f'{lid}.bin wrong byte size')
    return np.fromfile(p,'<u2').reshape(N,N)


def at(a, lat, lon):
    r,c = pixel(lat,lon,a.shape[0])
    return float(a[r,c])


def haversine(lat1,lon1,lat2,lon2):
    p1,p2 = np.radians([lat1,lat2]); dphi=p2-p1; dlam=np.radians(lon2-lon1)
    return 2*R*np.arcsin(np.sqrt(np.sin(dphi/2)**2+np.cos(p1)*np.cos(p2)*np.sin(dlam/2)**2))/1000


def check_vectors():
    meta=json.loads((OUT/'craters.json').read_text())
    a=np.fromfile(OUT/'craters.bin','<f4').reshape(-1,3)
    test(len(a)==meta['count'],'crater count mismatch')
    test(np.all(np.isfinite(a)), 'nonfinite crater record')
    test(np.all(np.diff(a[:,2])<=0),'craters not diameter descending')
    test(np.all((a[:,0]>=-90)&(a[:,0]<=90)&(a[:,1]>=-180)&(a[:,1]<=180)),'crater coordinates invalid')
    test(np.all((a[:,2]>=5)|((a[:,0]<=-75)&(a[:,2]>=1))),'crater filter violated')
    test(np.unique(a,axis=0).shape[0]==len(a),'duplicate crater triples')
    # Independently select every source row, not just the delivered count.
    path=PROJECT/'data-raw/usgs-robbins-craters/lunar_crater_database_robbins_2018_bundle/data/lunar_crater_database_robbins_2018.csv'
    expected=[]
    with path.open(newline='') as f:
        for row in csv.DictReader(f):
            d=float(row['DIAM_CIRC_IMG']); lat=float(row['LAT_CIRC_IMG'])
            if d>=5 or (lat<=-75 and d>=1):
                expected.append((lat,(float(row['LON_CIRC_IMG'])+180)%360-180,d))
    e=np.asarray(expected,dtype='<f4')
    key=lambda v: np.lexsort((v[:,1],v[:,0],v[:,2]))
    test(a.shape==e.shape and np.array_equal(a[key(a)],e[key(e)]),'craters differ from exact source selection')
    for lod in meta['lod']:
        test(lod['count']==int(np.sum(a[:,2]>=lod['minKm'])),f"LOD {lod['minKm']} mismatch")
    report={'count':len(a),'sourceSelectionExact':a.shape==e.shape and np.array_equal(a[key(a)],e[key(e)]),'lod':meta['lod']}
    if 'small' in meta:
        s=np.fromfile(OUT/meta['small']['file'],'<f4').reshape(-1,3)
        test(len(s)==meta['small']['count'],'small crater count mismatch')
        test(np.all(np.diff(s[:,2])<=0),'small craters not sorted')
        test('4.0' in meta['small']['licence'],'small crater redistribution licence missing')
        report['smallCount']=len(s)
    return report


def native_sample(lat,lon):
    path=ROOT/'features/downloads/psr-complete/LPSR_80S_20MPP_ADJ.TIF'
    x,y=xy(lat,lon)
    with rasterio.open(path) as ds:
        row,col=ds.index(x,y)
        return float(ds.read(1,window=((row,row+1),(col,col+1)))[0,0])


def main():
    entries=json.loads((OUT/'manifest-additions.json').read_text())
    test({e['id'] for e in entries}=={'craters','psr','waterice','danger'},'manifest IDs differ')
    for e in entries:
        test(set(e)==FIELDS, f"{e['id']} manifest fields differ from existing format")
        test(set(e['source'])==SOURCE_FIELDS,f"{e['id']} source fields differ")
        test(all(set(s)=={'value','color'} for s in e['legend']),f"{e['id']} legend fields differ")
    vals={lid:read(lid) for lid in ['psr','waterice','danger']}
    valid=mask(N)
    hist={}
    pngs={}
    for lid,a in vals.items():
        test(np.all(a[~valid]==65535),f'{lid}: data outside80S')
        present=valid&(a!=65535)
        if lid!='waterice':
            test(np.all(a[valid]!=65535),f'{lid}: nodata inside80S')
        test(np.all(a[present]<= (10000 if lid=='psr' else 3)),f'{lid}: out-of-range value')
        u,c=np.unique(a[present],return_counts=True)
        if lid=='psr':
            hist[lid]={'zero':int(np.sum(a[valid]==0)),'mixed':int(np.sum((a[valid]>0)&(a[valid]<10000))),
                       'full':int(np.sum(a[valid]==10000)), 'meanPercent':float(a[valid].mean()*.01),
                       'percentCellsContainingPsr':float(np.mean(a[valid]>0)*100)}
        else:
            hist[lid]={str(i):{'count':int(np.sum(a[present]==i)), 'percent':float(np.mean(a[present]==i)*100)} for i in range(4)}
        with Image.open(OUT/f'{lid}.png') as im:
            test(im.mode=='RGBA',f'{lid} PNG not RGBA')
            test(im.size in ([(4096,4096),(2048,2048)] if lid=='waterice' else [(4096,4096)]),f'{lid} PNG dimensions wrong')
            pngs[lid]=np.array(im)
        rgba=pngs[lid]
        test(np.all(rgba[...,3][~mask(rgba.shape[0])]==0),f'{lid} PNG visible outside80S')
    # Sharp PSR alpha must follow native weighted fractions, not nearest resampling.
    fractions=np.load(OUT/'psr-fraction-4096.npy',allow_pickle=False)
    native_meta=json.loads((ROOT/'features/downloads/psr-complete/metadata.json').read_text())
    native_ones=native_meta['native_counts']['1.0']
    integrated_ones=float(fractions.sum(dtype=np.float64)*(30400/4096)**2)
    test(abs(integrated_ones-native_ones)<10, 'PSR area not conserved from native pixels')
    alpha=np.where(mask(4096),np.rint(200*fractions),0).astype('u1')
    test(np.array_equal(alpha,pngs['psr'][...,3]),'PSR alpha not200*fraction')
    expected=np.rint(fractions.reshape(N,2,N,2).mean(axis=(1,3))*10000).astype('u2')
    test(np.array_equal(expected[valid],vals['psr'][valid]),'PSR bin not exact fraction encoding')
    test(np.all(pngs['psr'][...,:3][alpha>0]==[72,140,220]),'PSR RGB differs')
    watercolors={(0,0,0,0),(110,150,255,110),(80,210,255,170),(255,255,255,230)}
    test(all(tuple(p) in watercolors for p in np.unique(pngs['waterice'].reshape(-1,4),axis=0)), 'waterice palette differs')
    temp=np.fromfile(PROJECT/'app/public/data/layers/temp-max.bin','<u2').reshape(N,N)
    test(np.array_equal((vals['waterice']==65535)&valid, (temp==65535)&valid), 'waterice nodata differs from thermal source coverage')
    test(np.all((temp[vals['waterice']==2]<11000)&(vals['psr'][vals['waterice']==2]>0)), 'surface cold trap rule violated')
    with np.load(OUT/'waterice-thermal.npz') as thermal:
        depth=thermal['depth']
        buried=vals['waterice']==1
        test(np.all((depth[buried]>0)&(depth[buried]<=1)&(temp[buried]>=11000)), 'buried ice rule violated')
    test(not np.any(vals['waterice']==3),'orbital detection pixels present without detection coordinates')
    allowed={(0,0,0,0),(245,200,60,120),(245,130,40,150),(230,50,50,175)}
    unique=np.unique(pngs['danger'].reshape(-1,4),axis=0)
    test(all(tuple(p) in allowed for p in unique),'danger palette differs')
    # For interior cells the coarse bin is the worst fine-grid warning.
    fineclass=np.zeros((4096,4096),'u1')
    for value,alpha in [(1,120),(2,150),(3,175)]:
        fineclass[pngs['danger'][...,3]==alpha]=value
    coarse=fineclass.reshape(N,2,N,2).max(axis=(1,3))
    interior=minimum_filter(valid.astype('u1'),size=3)==1
    test(np.array_equal(coarse[interior],vals['danger'][interior]),'danger bin not worst2x2 fine class')
    old=np.fromfile(PROJECT/'app/public/data/layers/ice.bin','<u2').reshape(N,N)
    compare=valid&(old!=65535)
    on=(vals['psr']>=5000)&(vals['psr']!=65535)
    tp=int(np.sum(compare&on&(old==1)));fp=int(np.sum(compare&on&(old==0)))
    fn=int(np.sum(compare&~on&(old==1)));tn=int(np.sum(compare&~on&(old==0)))
    agreement={'rule':'new>=50% versus old flag==1, inside80S', 'tp':tp,'fp':fp,'fn':fn,'tn':tn,
               'agreementPercent':100*(tp+tn)/compare.sum(),'intersectionOverUnionPercent':100*tp/(tp+fp+fn)}
    sites=[]
    for name,lat,lon in [('Shackleton floor',-89.67,129.2),('LCROSS impact',-84.675,-48.725),('Malapert massif summit',-85.99,2.9)]:
        row={'name':name,'lat':lat,'lon':lon,'rowCol':pixel(lat,lon),
             'psrPercent':at(vals['psr'],lat,lon)*.01,'native20mPsr':native_sample(lat,lon),
             'watericeClass':int(at(vals['waterice'],lat,lon)),'dangerClass':int(at(vals['danger'],lat,lon))}
        sites.append(row)
        if name!='Malapert massif summit':
            test(row['psrPercent']>0 and row['native20mPsr']==1,f'{name} not PSR')
        else:
            test(row['psrPercent']==0 and row['native20mPsr']==0,'Malapert summit incorrectly PSR')
        if name=='Shackleton floor':
            test(row['watericeClass']==2,'Shackleton floor not predicted surface cold trap')
    names=json.loads((PROJECT/'app/public/data/names.json').read_text())
    names={r[0]:dict(zip(names['fields'],r)) for r in names['rows']}
    cabeus=names['Cabeus']
    distance=haversine(-84.675,-48.725,cabeus['lat'],cabeus['lon'])
    test(distance<cabeus['diameterKm']/2,'LCROSS coordinate outside Cabeus circular outline')
    lc={'impactDistanceFromIauCenterKm':float(distance),'iauCabeus':cabeus,'insideCircularRim':bool(distance<cabeus['diameterKm']/2)}
    axis=-HALF+(np.arange(N)+.5)*RES
    cx,cy=xy(names['Shackleton']['lat'],names['Shackleton']['lon'])
    rad=names['Shackleton']['diameterKm']*500
    rr=(axis[None,:]-cx)**2+(axis[::-1,None]-cy)**2
    ring=(rr>(.7*rad)**2)&(rr<(1.1*rad)**2)
    red=np.argwhere(ring&(vals['danger']==3))
    test(len(red)>0,'No class3 slope on Shackleton walls')
    wall={'class3Cells':len(red),'wallRingRadiusFraction':[.7,1.1]}
    if len(red):
        row,col=red[len(red)//2];lat,lon=latlon(axis[col],axis[::-1][row])
        wall.update(lat=float(lat),lon=float(lon),dangerClass=3)
    sun=np.fromfile(PROJECT/'app/public/data/layers/sunlight.bin','<u2').reshape(N,N)
    slope=np.fromfile(PROJECT/'app/public/data/layers/slope.bin','<u2').reshape(N,N)
    candidates=(vals['danger']==0)&(vals['psr']==0)&(sun>5000)&(sun!=65535)&(maximum_filter(slope,size=5)<300)&valid
    coords=np.argwhere(candidates)
    test(len(coords)>0,'No flat sunlit plain spot found')
    plain={}
    if len(coords):
        tx,ty=xy(-82,30)
        i=np.argmin((axis[coords[:,1]]-tx)**2+(axis[::-1][coords[:,0]]-ty)**2)
        row,col=coords[i];lat,lon=latlon(axis[col],axis[::-1][row])
        plain={'name':'Flat, seasonally sunlit plain sample','lat':float(lat),'lon':float(lon),
               'dangerClass':int(vals['danger'][row,col]),'psrPercent':float(vals['psr'][row,col]*.01),
               'averageSunlightPercent':float(sun[row,col]*.01),'coarseSlopeDeg':float(slope[row,col]*.01),
               'selection':'Nearest -82,30 with danger0, PSR0, averageSun>50%, coarse slope<3deg throughout5x5 cells'}
    # Analytic roundtrip and cardinal coordinates ensure image orientation.
    orient={}
    for tag,lat,lon in [('0E_up',-85,0),('90E_right',-85,90),('180E_down',-85,180),('90W_left',-85,-90)]:
        x,y=xy(lat,lon);lat2,lon2=latlon(x,y)
        test(abs(lat-lat2)<1e-10 and abs(((lon-lon2+180)%360)-180)<1e-10,'coordinate roundtrip failed')
        orient[tag]={'x':float(x),'y':float(y),'rowCol':pixel(lat,lon)}
    test(orient['0E_up']['rowCol'][0]<N/2 and orient['90E_right']['rowCol'][1]>N/2,'orientation reversed')
    ice_sites=json.loads((OUT/'ice-sites.json').read_text())
    for site in ice_sites:
        test(site['name'] in names,f"unknown IAU name {site['name']}")
        if site['name'] in names:
            truth=names[site['name']]
            test(all(site[k]==truth[k] for k in ['lat','lon','diameterKm']),f"marker {site['name']} differs from IAU names.json")
        test(len(site['short'])<=90,f"marker {site['name']} short>90 chars")
        test(site['status'] in ['confirmed','detected','predicted'],f"marker {site['name']} status invalid")
        test(bool(site['evidence']),f"marker {site['name']} no evidence")
        test(site['status']!='confirmed' or site['name']=='Cabeus','direct confirmation claimed outside Cabeus')
    report={'passed':not PROBLEMS,'problems':PROBLEMS,'histograms':hist,
            'coverageDenominator':'Class percentages use each layer\'s valid cells inside80S; waterice preserves264 missing-temperature edge cells.',
            'inside80SNoData':{lid:int(np.sum((a==65535)&valid)) for lid,a in vals.items()},'psrAgreement':agreement,
            'psrConservation':{'nativeShadowPixels':native_ones,'weightedOutputInSourcePixels':integrated_ones},'spotChecks':sites,
            'lcrossInsideCabeus':lc,'shackletonWalls':wall,'flatSunlitPlain':plain,'orientation':orient,
            'craters':check_vectors(),'iceSites':len(ice_sites),
            'files':{p.name:p.stat().st_size for p in sorted(OUT.iterdir()) if p.is_file() and p.suffix in ['.bin','.png','.json']}}
    report['passed']=not PROBLEMS
    (OUT/'check-report.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report,indent=2))
    if PROBLEMS:
        raise SystemExit(1)


if __name__=='__main__':
    main()
