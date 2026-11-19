import assert from 'node:assert/strict';
import test from 'node:test';
import {qwenSentenceText} from './qwen';

test('preserves punctuation returned on Qwen word tokens',()=>{
 const sentence={
  text:'Bạn khỏe không',
  words:[
   {text:'Bạn',punctuation:' '},
   {text:'khỏe',punctuation:' '},
   {text:'không',punctuation:'?'}
  ]
 };
 assert.equal(qwenSentenceText(sentence),'Bạn khỏe không?');
});

test('falls back to sentence text when Qwen has no word tokens',()=>{
 assert.equal(qwenSentenceText({text:'Xin chào.'}),'Xin chào.');
});
