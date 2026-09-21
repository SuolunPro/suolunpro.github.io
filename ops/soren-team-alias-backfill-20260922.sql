-- Exact aliases verified against FotMob team search, competition, opponent,
-- kickoff time and/or a matching FotMob fixture. This script is idempotent.
with v(jc_team,fotmob_team_id,fotmob_team) as (values
('KFUM奥斯陆',2305,'KFUM'),('OFI克里特',7753,'OFI Crete'),
('RB大宫松鼠',4398,'RB Omiya Ardija'),('上海海港',198616,'Shanghai Port'),
('上海申花',6628,'Shanghai Shenhua'),('不莱梅',8697,'Werder Bremen'),
('中国U23',317240,'China U23'),('中国香港U23',951610,'Hong Kong U23'),
('乌兹女',1243552,'Uzbekistan (W)'),('仙台七夕',162192,'Vegalta Sendai'),
('伊朗U23',622101,'Iran U23'),('克劳利',8647,'Crawley Town'),
('北京国安',4177,'Beijing Guoan'),('卡塔尔U23',304032,'Qatar U23'),
('吉尔吉斯坦U23',638900,'Kyrgyzstan U23'),('埃弗斯堡',8232,'Elversberg'),
('基多体育大学',6721,'LDU de Quito'),('山谷独立',192875,'Independiente del Valle'),
('拉查布里府',421346,'Ratchaburi FC'),('日本U23',298067,'Japan U23'),
('朝鲜U23',624265,'North Korea U23'),('札幌冈萨',112688,'Hokkaido Consadole Sapporo'),
('杜连斯',212820,'Torreense'),('格尼斯坦',2361,'IF Gnistan'),
('格拉茨',10014,'Sturm Graz'),('格林斯比',10005,'Grimsby Town'),
('沃夫斯堡',8721,'Wolfsburg'),('沙特U23',610874,'Saudi Arabia U23'),
('泰国U23',623768,'Thailand U23'),('淡滨尼士',67386,'Tampines Rovers FC'),
('瓦斯特拉斯',6194,'Västerås SK'),('米尔顿',8645,'Milton Keynes Dons'),
('艾因',102117,'Al-Ain'),('菲律宾女',633428,'Philippines (W)'),
('藤枝MYFC',305776,'Fujieda MYFC'),('诺茨郡',9819,'Notts County'),
('赫塔菲',8305,'Getafe'),('赫尔蒙德',6417,'Helmond Sport'),
('达姆斯塔',8262,'Darmstadt'),('邓伯什',9835,'FC Den Bosch'),
('阿联酋U23',316113,'UAE U23'),('韩国U23',300702,'South Korea U23')
)
insert into public.soren_team_alias_fotmob
  (jc_team,fotmob_team_id,fotmob_team,league_cn,evidence_n,confidence,updated_at)
select v.jc_team,v.fotmob_team_id,v.fotmob_team,
  coalesce((select m.league from public.soren_matches m
    where m.home_team=v.jc_team or m.away_team=v.jc_team
    order by m.pool_date desc limit 1),'跨赛事身份'),
  greatest((select count(*)::int from public.soren_matches m
    where m.home_team=v.jc_team or m.away_team=v.jc_team),1),
  'verified_exact_identity_20260922',now()
from v
where not exists (
  select 1 from public.soren_team_alias_fotmob a where a.jc_team=v.jc_team
);
